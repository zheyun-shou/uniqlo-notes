// 优衣库商品查询。
// 官网商品页的 HTML 里嵌着完整的商品数据（window.__PRELOADED_STATE__ → entity.pdpEntity），
// 名称、分类、颜色、尺码、价格、各颜色图片都在里面，这里直接从页面读取。
// （官网的 commerce 接口要求官网前端专用的客户端标识，我们不冒充，所以不用接口。）
// 字段可能随官网改版变化，解析一律做成“尽量取、取不到就留空”；
// 读不到嵌入数据时退回 og 标签 / JSON-LD。

// 如实标明身份，不伪装成浏览器
const UA = 'uniqlo-notes/0.1 (personal fit log; +https://github.com/zheyun-shou/uniqlo-notes)';

/**
 * 把用户输入解析成商品编号。支持：
 *   465185 / E465185-000 / 465185-000 / 官网商品链接
 */
export function parseProductInput(raw) {
  let s = String(raw || '').trim();
  try {
    s = decodeURIComponent(s);
  } catch {}
  const m = s.match(/(?:^|[^A-Za-z0-9])([A-Za-z]?)(\d{6})(?:-(\d{3}))?(?![0-9])/) || s.match(/([A-Za-z]?)(\d{6})(?:-(\d{3}))?/);
  if (!m) return null;
  const code = m[2];
  const prefix = (m[1] || 'E').toUpperCase();
  const suffix = m[3] || '000';
  // 链接里 /products/E465185-000/00 的最后一段是 priceGroup
  const pg = s.match(/\/products\/[A-Za-z]?\d{6}-\d{3}\/(\d{2})/);
  return { code, productId: `${prefix}${code}-${suffix}`, priceGroup: pg ? pg[1] : null };
}

export function productPageUrl(region, lang, productId, priceGroup = '00') {
  return `https://www.uniqlo.com/${region}/${lang}/products/${productId}/${priceGroup || '00'}`;
}

/** 请求商品页，返回原始结果（也用于 /raw 调试接口） */
export async function fetchUpstream(input, { region, lang }) {
  const parsed = parseProductInput(input);
  if (!parsed) return { parsed: null, steps: [] };
  const url = productPageUrl(region, lang, parsed.productId, parsed.priceGroup);
  const step = { name: 'page', url, status: 0 };
  let product = null;
  let meta = null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    step.status = res.status;
    if (res.ok) {
      const html = await res.text();
      product = extractPdpProduct(html, parsed.productId);
      if (!product) meta = parseHtml(html);
      step.found = product ? 'preloadedState' : meta?.name ? 'meta' : 'none';
    }
  } catch (e) {
    step.error = String(e?.message || e);
  }
  return { parsed, product, meta, steps: [step] };
}

/**
 * 查询并整理成前端用的统一结构。
 * 返回 { product }；查不到时 product 为 null，upstreamDown 表示优衣库根本没正常响应（被拦截/宕机）。
 * 本站没有的商品（比如只在门店卖、官网只在别国上架的加长款）会再去 opts.fallback 里的站点查，
 * 查到的话 product.region 标明来源站点，外币价格只作参考（refPrice），不当作本地价格。
 */
export async function lookupProduct(input, opts) {
  const first = await lookupIn(input, opts);
  if (first.product || first.upstreamDown || !first.parsed || !opts.fallback?.length) return first;
  const others = await Promise.all(
    opts.fallback.filter((o) => o.region !== opts.region).map((o) => lookupIn(input, o).then((r) => ({ ...r, o }))),
  );
  const hit = others.find((r) => r.product);
  if (!hit) return first;
  const { product } = hit;
  product.region = hit.o.region;
  product.refPrice = product.price ? { ...product.price, base: product.basePrice?.value ?? null, region: hit.o.region } : null;
  product.price = null;
  product.basePrice = null;
  return { product };
}

async function lookupIn(input, opts) {
  const { parsed, product, meta, steps } = await fetchUpstream(input, opts);
  if (!parsed) return { parsed, product: null };
  if (product) return { parsed, product: normalizeApi(product, product, parsed, opts) };
  if (meta?.name) return { parsed, product: normalizePage(meta, parsed, steps[0].url) };
  const upstreamDown = steps.every((s) => !s.status || s.status >= 500 || s.status === 403 || s.status === 429);
  return { parsed, product: null, upstreamDown, statuses: steps.map((s) => `${s.name}:${s.status}`) };
}

/**
 * 从商品页 HTML 里取出 pdpEntity 里的商品对象。
 * 整个 __PRELOADED_STATE__ 接近 1MB，Workers 免费套餐 CPU 时间很紧，
 * 所以只定位到 "pdpEntity" 这一小段（约 10KB）再解析。
 */
export function extractPdpProduct(html, productId) {
  let from = 0;
  for (;;) {
    const i = html.indexOf('"pdpEntity":', from);
    if (i < 0) return null;
    from = i + 12;
    const start = html.indexOf('{', from);
    if (start < 0) return null;
    const end = matchBrace(html, start);
    if (end < 0) continue;
    let entity;
    try {
      entity = JSON.parse(html.slice(start, end + 1));
    } catch {
      continue;
    }
    const products = Object.values(entity || {})
      .map((e) => e?.product)
      .filter((p) => p?.productId);
    if (products.length) return products.find((p) => p.productId === productId) || products[0];
  }
}

// 从 start 处的 { 开始，找到与之配对的 }（跳过字符串里的括号）
function matchBrace(s, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (inStr) {
      if (c === 92) i++; // \
      else if (c === 34) inStr = false; // "
    } else if (c === 34) inStr = true;
    else if (c === 123) depth++; // {
    else if (c === 125 && --depth === 0) return i; // }
  }
  return -1;
}

// ---------- 解析 ----------

function str(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return v.name || v.locale || v.displayName || '';
}

function absUrl(u) {
  if (!u || typeof u !== 'string') return null;
  if (u.startsWith('//')) return 'https:' + u;
  return u;
}

export function normalizeApi(item, details, parsed, { region, lang }) {
  const images = [];
  const seen = new Set();
  const push = (url, color) => {
    url = absUrl(url);
    if (url && !seen.has(url)) {
      seen.add(url);
      images.push({ url, color: color || null });
    }
  };
  const imgs = item.images || details?.images || {};
  const main = imgs.main;
  if (Array.isArray(main)) {
    for (const x of main) push(typeof x === 'string' ? x : x?.url || x?.image, x?.colorCode || x?.color);
  } else if (main && typeof main === 'object') {
    for (const [color, v] of Object.entries(main)) push(typeof v === 'string' ? v : v?.image || v?.url, color);
  }
  for (const x of imgs.sub || []) push(typeof x === 'string' ? x : x?.url || x?.image, null);

  const colors = (item.colors || details?.colors || []).map((c) => {
    const code = str(c.displayCode || c.code);
    return { code, name: str(c.name), chip: absUrl(imgs.chip?.[code]) || null };
  });
  const sizes = (item.sizes || details?.sizes || []).map((s) => str(s.name || s.displayCode || s.code)).filter(Boolean);

  const prices = item.prices || details?.prices || {};
  const toPrice = (o) => (o ? { value: o.value ?? null, currency: str(o.currency?.code || prices.base?.currency?.code) } : null);
  // price 是当前售价（有折扣时为折后价），basePrice 是没打折的原价
  const price = toPrice(prices.promo || prices.base);
  const basePrice = toPrice(prices.base);

  const category = breadcrumbNames(details?.breadcrumbs || item.breadcrumbs);
  const gender = str(item.genderCategory || item.genderName || details?.genderCategory) || category[0] || '';

  const priceGroup = parsed.priceGroup || item.priceGroup || '00';
  return {
    productId: item.productId,
    code: parsed.code,
    name: str(item.name || details?.name),
    gender,
    category,
    images,
    colors,
    sizes,
    price,
    basePrice,
    composition: str(details?.composition) || '',
    rating: item.rating ? { average: item.rating.average ?? null, count: item.rating.count ?? null } : null,
    url: productPageUrl(region, lang, item.productId, priceGroup),
    source: 'api',
    fetchedAt: Date.now(),
  };
}

function breadcrumbNames(b) {
  if (!b) return [];
  const list = Array.isArray(b) ? b : ['gender', 'class', 'category', 'subcategory'].map((k) => b[k]);
  return list.map(str).filter(Boolean);
}

export function parseHtml(html) {
  const meta = (prop) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
    return decodeEntities((html.match(re) || html.match(re2) || [])[1] || '');
  };
  const out = { name: meta('og:title'), images: [], category: [], price: null };
  const ogImg = meta('og:image');
  if (ogImg) out.images.push(ogImg);

  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    for (const node of [].concat(data?.['@graph'] || data)) {
      if (node?.['@type'] === 'Product') {
        out.name = node.name || out.name;
        for (const im of [].concat(node.image || [])) if (typeof im === 'string') out.images.push(im);
        if (node.category) out.category = [].concat(node.category).map(String);
        const offer = [].concat(node.offers || [])[0];
        if (offer?.price) out.price = { value: Number(offer.price), currency: offer.priceCurrency || '' };
      } else if (node?.['@type'] === 'BreadcrumbList') {
        const names = (node.itemListElement || []).map((x) => x?.name || x?.item?.name).filter(Boolean);
        if (names.length && !out.category.length) out.category = names.slice(1, -1).length ? names.slice(1, -1) : names;
      }
    }
  }
  out.name = out.name.replace(/\s*[|｜-]\s*UNIQLO.*$/i, '').trim();
  return out;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizePage(meta, parsed, url) {
  return {
    productId: parsed.productId,
    code: parsed.code,
    name: meta.name,
    gender: meta.category[0] || '',
    category: meta.category,
    images: [...new Set(meta.images.map(absUrl).filter(Boolean))].map((u) => ({ url: u, color: null })),
    colors: [],
    sizes: [],
    price: meta.price,
    basePrice: null,
    composition: '',
    rating: null,
    url,
    source: 'page',
    fetchedAt: Date.now(),
  };
}

// ---------- 按名称搜索 ----------

export function searchPageUrl(region, lang, q) {
  return `https://www.uniqlo.com/${region}/${lang}/search?q=${encodeURIComponent(q)}`;
}

/** 请求官网搜索页，返回原始 HTML（也用于 /api/search/raw 调试） */
export async function fetchSearchPage(q, { region, lang }) {
  const url = searchPageUrl(region, lang, q);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    return { url, status: res.status, html: res.ok ? await res.text() : '' };
  } catch (e) {
    return { url, status: 0, error: String(e?.message || e), html: '' };
  }
}

/**
 * 从搜索页 HTML 里取出商品格子：每个格子是一个 class 含 product-tile__link 的 <a>，
 * href 里有商品编号和 priceGroup，aria-label 是「名称, 价格, 性别」，后面紧跟商品图。
 */
export function parseSearchResults(html, max = 24) {
  const out = [];
  const seen = new Set();
  for (let i = html.indexOf('product-tile__link'); i >= 0 && out.length < max; i = html.indexOf('product-tile__link', i + 1)) {
    const start = html.lastIndexOf('<a', i);
    const end = html.indexOf('>', i);
    if (start < 0 || end < 0) continue;
    const tag = html.slice(start, end);
    const href = (tag.match(/href="([^"]+)"/) || [])[1] || '';
    const m = href.match(/\/products\/([A-Z]\d{6}-\d{3})\/(\d{2})/);
    if (!m || seen.has(m[1] + m[2])) continue;
    seen.add(m[1] + m[2]);
    const label = decodeEntities((tag.match(/aria-label="([^"]*)"/) || [])[1] || '');
    const rest = html.slice(end, end + 4000);
    const imgTag = (rest.match(/<img[^>]+>/) || [])[0] || '';
    const image = decodeEntities((imgTag.match(/src="([^"]+)"/) || [])[1] || '');
    const alt = decodeEntities((imgTag.match(/alt="([^"]*)"/) || [])[1] || '');
    // 「Baggy Barrel Leg Jeans, 399 kr, Reduced Price, Unisex」：名称、价格，后面是若干标记；
    // 名称里也可能有逗号，所以以第一个带数字的片段为价格
    const segs = label.split(', ');
    const pi = segs.findIndex((x, k) => k > 0 && /\d/.test(x));
    out.push({
      productId: m[1],
      priceGroup: m[2],
      name: alt || (pi > 0 ? segs.slice(0, pi).join(', ') : label),
      price: pi > 0 ? segs[pi] : '',
      flags: pi > 0 ? segs.slice(pi + 1) : [],
      image: image ? image.replace(/\?width=\d+/, '?width=450') : null,
    });
  }
  return out;
}

// ---------- 降价提醒用的价格查询 ----------

// 欧洲站的「Reduced Price」常常是单独的 priceGroup（/01），和原价款（/00）是两个页面，所以两个都查
const WATCH_PRICE_GROUPS = ['00', '01'];

/**
 * 查一个商品各 priceGroup 的当前售价。
 * 返回 { found, upstreamDown, name, image, url, currency, base, min, groups: [{ priceGroup, price, base, colors }] }
 */
export async function fetchPrices(productId, opts) {
  const groups = [];
  let info = null;
  let statuses = [];
  for (const g of WATCH_PRICE_GROUPS) {
    const r = await fetchUpstream(`/products/${productId}/${g}`, opts);
    statuses.push(r.steps[0]?.status || 0);
    if (!r.product) continue;
    const p = normalizeApi(r.product, r.product, r.parsed, opts);
    if (p.price?.value == null) continue;
    info ||= p;
    groups.push({
      priceGroup: g,
      price: p.price.value,
      base: p.basePrice?.value ?? p.price.value,
      currency: p.price.currency,
      colors: p.colors.map((c) => `${c.code} ${c.name}`.trim()),
      url: p.url,
    });
  }
  if (!groups.length) {
    const upstreamDown = statuses.every((s) => !s || s >= 500 || s === 403 || s === 429);
    return { found: false, upstreamDown, groups };
  }
  const cheapest = groups.reduce((a, b) => (b.price < a.price ? b : a));
  return {
    found: true,
    name: info.name,
    image: info.images[0]?.url || null,
    url: cheapest.url,
    currency: cheapest.currency,
    base: Math.max(...groups.map((g) => g.base)),
    min: cheapest.price,
    saleColors: cheapest.price < Math.max(...groups.map((g) => g.base)) ? cheapest.colors : [],
    groups,
  };
}
