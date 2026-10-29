// 优衣库商品查询。
// 优衣库没有公开文档的 API；这里用的是官网前端自己调用的 commerce v5 接口，
// 字段可能随时变化，所以解析一律做成“尽量取、取不到就留空”，
// 接口失败时再退回解析商品页 HTML（og 标签 / JSON-LD）。

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

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

function apiBase(region, lang) {
  return `https://www.uniqlo.com/${region}/api/commerce/v5/${lang}`;
}

export function productPageUrl(region, lang, productId, priceGroup = '00') {
  return `https://www.uniqlo.com/${region}/${lang}/products/${productId}/${priceGroup || '00'}`;
}

async function getJson(url, region) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        'x-fr-clientid': `uq.${region}.web-spa`,
      },
    });
  } catch (e) {
    return { url, status: 0, json: null, error: String(e?.message || e) };
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { url, status: res.status, json, text: json ? undefined : text.slice(0, 500) };
}

const itemsOf = (r) => r?.json?.result?.items || r?.json?.items || [];

/** 调用上游，返回原始响应（也用于 /raw 调试接口） */
export async function fetchUpstream(input, { region, lang }) {
  const parsed = parseProductInput(input);
  if (!parsed) return { parsed: null, steps: [] };
  const base = apiBase(region, lang);
  const steps = [];

  // 1) 按完整编号
  const byId = await getJson(
    `${base}/products?productIds=${encodeURIComponent(parsed.productId)}&httpFailure=true`,
    region,
  );
  steps.push({ name: 'byId', ...byId });
  let item = itemsOf(byId)[0];

  // 2) 用 6 位数字搜索（后缀不是 -000 或前缀不是 E 时）
  if (!item) {
    const search = await getJson(`${base}/products?q=${parsed.code}&limit=10&httpFailure=true`, region);
    steps.push({ name: 'search', ...search });
    const list = itemsOf(search);
    item = list.find((x) => String(x.productId || '').includes(parsed.code)) || null;
  }

  // 3) 详情：分类面包屑、材质等
  let details = null;
  if (item?.productId) {
    const pg = parsed.priceGroup || item.priceGroup || '00';
    const d = await getJson(
      `${base}/products/${encodeURIComponent(item.productId)}/price-groups/${pg}/details?includeModelSize=false&httpFailure=true`,
      region,
    );
    steps.push({ name: 'details', ...d });
    details = d.json?.result || null;
  }

  // 4) 接口都没拿到 → 商品页 HTML
  let page = null;
  if (!item) {
    const url = productPageUrl(region, lang, parsed.productId, parsed.priceGroup);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
      const html = await res.text();
      page = { url, status: res.status, meta: res.ok ? parseHtml(html) : null };
    } catch (e) {
      page = { url, status: 0, error: String(e) };
    }
    steps.push({ name: 'page', ...page });
  }

  return { parsed, item, details, page, steps };
}

/**
 * 查询并整理成前端用的统一结构。
 * 返回 { product }；查不到时 product 为 null，upstreamDown 表示优衣库根本没正常响应（被拦截/宕机）。
 */
export async function lookupProduct(input, opts) {
  const { parsed, item, details, page, steps } = await fetchUpstream(input, opts);
  if (!parsed) return { product: null };
  if (item) return { product: normalizeApi(item, details, parsed, opts) };
  if (page?.meta?.name) return { product: normalizePage(page.meta, parsed, page.url) };
  const upstreamDown = steps.every((s) => !s.status || s.status >= 500 || s.status === 403 || s.status === 429);
  return { product: null, upstreamDown, statuses: steps.map((s) => `${s.name}:${s.status}`) };
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

  const colors = (item.colors || details?.colors || []).map((c) => ({
    code: str(c.displayCode || c.code),
    name: str(c.name),
  }));
  const sizes = (item.sizes || details?.sizes || []).map((s) => str(s.name || s.displayCode || s.code)).filter(Boolean);

  const prices = item.prices || details?.prices || {};
  const priceObj = prices.promo || prices.base || null;
  const price = priceObj
    ? { value: priceObj.value ?? null, currency: str(priceObj.currency?.code || prices.base?.currency?.code) }
    : null;

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
    composition: '',
    rating: null,
    url,
    source: 'page',
    fetchedAt: Date.now(),
  };
}
