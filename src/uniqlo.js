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
 */
export async function lookupProduct(input, opts) {
  const { parsed, product, meta, steps } = await fetchUpstream(input, opts);
  if (!parsed) return { product: null };
  if (product) return { product: normalizeApi(product, product, parsed, opts) };
  if (meta?.name) return { product: normalizePage(meta, parsed, steps[0].url) };
  const upstreamDown = steps.every((s) => !s.status || s.status >= 500 || s.status === 403 || s.status === 429);
  return { product: null, upstreamDown, statuses: steps.map((s) => `${s.name}:${s.status}`) };
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
    .replace(/&#39;/g, "'")
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
