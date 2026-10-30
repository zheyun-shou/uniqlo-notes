// 试穿手记前端：无构建步骤的原生 JS，hash 路由。

const TOKEN_KEY = 'fitlog.token';
const CACHE_KEY = 'fitlog.entries';

const CATEGORIES = [
  // [key, 名称, 匹配优衣库分类/商品名的关键词（英文+瑞典语）]
  ['inner', 'Innerwear', /innerwear|underwear|underkläder|\bbra\b|boxer|briefs|socks|strumpor/i],
  ['lounge', 'Loungewear', /lounge|pajama|pyjamas|room ?wear|sleepwear|relaco/i],
  ['acc', 'Accessories', /\bbags?\b|väska|\bhats?\b|\bcaps?\b|mössa|scarf|halsduk|gloves?|vantar|belts?|bälte|shoes|skor|accessor/i],
  ['skirt', 'Skirts & Dresses', /skirts?|kjol|\bdress(es)?\b(?!\s*shirt)|klänning/i],
  ['pants', 'Bottoms', /pants|trousers|byxa|byxor|jeans|chinos?|\bshorts\b|joggers?|leggings/i],
  ['down', 'Down & Padded', /(?<![-\w])down\b|\bdun\b|puffer|padded|vadderad/i],
  ['outer', 'Outerwear', /jackets?|jacka|coats?|kappa|blousons?|\brock\b|blazer|parka|outerwear|ytterkläder|\bvests?\b|väst|gilet/i],
  ['knit', 'Knitwear', /knit|sweaters?|cardigan|stickad|kofta|merino|cashmere|kashmir/i],
  ['sweat', 'Sweats & Fleece', /sweatshirt|sweat|hoodie|huvtröja|fleece/i],
  ['tops', 'T-shirts & Tops', /t-?shirts?|\btees?\b|\btops?\b|topp|polo|tank|linne|airism|heattech/i],
  ['shirts', 'Shirts', /shirts?|skjorta|blouse|blus/i],
  ['other', 'Other', null],
];
const CAT_NAME = Object.fromEntries(CATEGORIES.map(([k, n]) => [k, n]));

const FIT = { small: 'Runs small', true: 'True to size', large: 'Runs large' };
// 官网没给出尺码列表时用的常见尺码
const DEFAULT_SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
const LENGTH = { short: 'Too short', ok: 'Just right', long: 'Too long' };
const REGION_NAME = { se: 'Sweden', uk: 'UK', us: 'US', au: 'Australia', sg: 'Singapore', jp: 'Japan', de: 'Germany', fr: 'France' };
const VERDICT = { bought: 'Bought', want: 'Want', totry: 'To try', maybe: 'Maybe', pass: 'Pass' };

const app = document.getElementById('app');
const fab = document.getElementById('fab');

const state = {
  token: safeGet(TOKEN_KEY),
  entries: null,
  filter: { q: '', cat: 'all', verdict: 'all' },
};

// ---------- 工具 ----------

function safeGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k, v) {
  try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {}
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// 页面大标题：小号大写前缀 + 小写粗体加句点
function pageHead(eyebrow, title, extra = '') {
  return `<div class="page-head"><div><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}.</h1></div>${extra}</div>`;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function stars(n) {
  n = Number(n) || 0;
  if (!n) return '';
  return `<span class="stars" aria-label="${n} stars">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>`;
}

function price(p) {
  if (!p || p.value == null) return '';
  try {
    return new Intl.NumberFormat('sv-SE', { style: 'currency', currency: p.currency || 'SEK', maximumFractionDigits: 0 }).format(p.value);
  } catch {
    return `${p.value} ${p.currency || ''}`;
  }
}

// image 可以是 { url, archived } 或纯地址。有存档时优先显示存档，加载失败再回退官网原图
function img(image, alt = '') {
  if (!image) return '';
  const { url, archived } = typeof image === 'string' ? { url: image } : image;
  const src = archived ? `/media/${archived}` : url;
  if (!src) return '';
  const fallback = archived && url ? ` data-fallback="${esc(url)}"` : '';
  return `<img src="${esc(src)}"${fallback} alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer">`;
}

document.addEventListener(
  'error',
  (ev) => {
    const t = ev.target;
    if (t.tagName === 'IMG' && t.dataset.fallback) {
      const u = t.dataset.fallback;
      delete t.dataset.fallback;
      t.src = u;
    }
  },
  true,
);

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

export function guessCategory(product) {
  const texts = [(product.category || []).join(' / '), product.name || ''];
  for (const text of texts) {
    if (!text) continue;
    for (const [key, , re] of CATEGORIES) if (re && re.test(text)) return key;
  }
  return 'other';
}

function heroImage(entry) {
  const p = entry.product || {};
  const imgs = p.images || [];
  if (entry.color) {
    const code = String(entry.color).split(' ')[0];
    const m = imgs.find((i) => i.color && (i.color === code || i.color.endsWith(code)));
    if (m) return m;
  }
  return imgs[0] || null;
}

// ---------- API ----------

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${state.token || ''}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401) {
    state.token = null;
    safeSet(TOKEN_KEY, null);
    location.hash = '#/login';
    throw new ApiError(401, data);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

async function loadEntries(force = false) {
  if (state.entries && !force) return state.entries;
  try {
    const { entries } = await api('/entries');
    state.entries = entries;
    safeSet(CACHE_KEY, JSON.stringify(entries));
  } catch (e) {
    if (e.status === 401) throw e;
    const cached = safeGet(CACHE_KEY);
    if (!cached) throw e;
    state.entries = JSON.parse(cached);
    toast('Offline — showing your last synced records');
  }
  return state.entries;
}

function upsertLocal(entry) {
  const list = state.entries || [];
  const i = list.findIndex((e) => e.id === entry.id);
  if (i >= 0) list.splice(i, 1);
  list.unshift(entry);
  state.entries = list;
  safeSet(CACHE_KEY, JSON.stringify(list));
}

// ---------- 路由 ----------

const routes = [
  [/^#\/login$/, renderLogin],
  [/^#\/new(?:\/(.+))?$/, (m) => renderNew(m[1] ? decodeURIComponent(m[1]) : '')],
  [/^#\/entry\/([^/]+)$/, (m) => renderDetail(m[1])],
  [/^#\/edit\/([^/]+)$/, (m) => renderEdit(m[1])],
  [/^#\/settings$/, renderSettings],
  [/^#\/watch$/, renderWatch],
  [/^#?\/?$/, renderList],
];

async function router() {
  const hash = location.hash || '#/';
  if (!state.token && hash !== '#/login') {
    location.hash = '#/login';
    return;
  }
  fab.hidden = !(hash === '#/' || hash === '' || hash === '#');
  window.scrollTo(0, 0);
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      try {
        await fn(m);
      } catch (e) {
        if (e.status !== 401) app.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p><p><a class="btn" href="#/">Back to home</a></p></div>`;
      }
      return;
    }
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', router);

// ---------- 登录 ----------

function renderLogin() {
  fab.hidden = true;
  app.innerHTML = `
    <section class="panel" style="max-width:420px;margin:40px auto">
      <h2>Enter access token</h2>
      <p class="hint" style="margin:0 0 12px">The value set with <code>wrangler secret put APP_TOKEN</code> when deploying. It is only stored on this device.</p>
      <form id="login" class="lookup">
        <input type="password" name="token" placeholder="APP_TOKEN" autocomplete="current-password" required>
        <button class="btn primary">Enter</button>
      </form>
      <p class="error" id="err" hidden></p>
    </section>`;
  const form = app.querySelector('#login');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    state.token = form.token.value.trim();
    const err = app.querySelector('#err');
    try {
      await api('/ping');
      safeSet(TOKEN_KEY, state.token);
      state.entries = null;
      location.hash = '#/';
    } catch (e) {
      err.hidden = false;
      err.textContent = e.status === 401 ? 'Wrong token' : e.message;
      if (e.status === 401) location.hash = '#/login';
    }
  });
  form.token.focus();
}

// ---------- 列表 ----------

async function renderList() {
  app.innerHTML = `${pageHead('My', 'closet')}<div class="grid" style="margin-top:16px">${'<div class="card"><div class="thumb skeleton"></div><div class="body"><div class="skeleton" style="height:14px"></div></div></div>'.repeat(4)}</div>`;
  const entries = await loadEntries();

  if (!entries.length) {
    app.innerHTML = `
      <div class="empty">
        <p class="eyebrow">Your closet is</p>
        <h2>empty.</h2>
        <p>Tap “+ Add” below and enter a product number or English product name.</p>
        <p><a class="btn primary" href="#/new">Add your first item</a></p>
      </div>`;
    return;
  }

  const catCounts = {};
  const verdictCounts = {};
  for (const e of entries) {
    catCounts[e.category || 'other'] = (catCounts[e.category || 'other'] || 0) + 1;
    if (e.verdict) verdictCounts[e.verdict] = (verdictCounts[e.verdict] || 0) + 1;
  }
  const f = state.filter;
  const chip = (group, key, label, n) =>
    `<button class="chip" data-group="${group}" data-key="${key}" aria-pressed="${f[group] === key}">${esc(label)}${n != null ? `<span class="n">${n}</span>` : ''}</button>`;

  app.innerHTML = `
    ${pageHead('My', 'closet', '<span class="count" id="count"></span>')}
    <input class="search" type="search" placeholder="Search my closet and uniqlo.com…" value="${esc(f.q)}" aria-label="Search">
    <div class="tabs" role="group" aria-label="Category">
      ${chip('cat', 'all', 'All')}
      ${CATEGORIES.filter(([k]) => catCounts[k]).map(([k, n]) => chip('cat', k, n, catCounts[k])).join('')}
    </div>
    <div class="filters" role="group" aria-label="Verdict" style="margin:0 0 20px">
      ${chip('verdict', 'all', 'All verdicts')}
      ${Object.entries(VERDICT).filter(([k]) => verdictCounts[k]).map(([k, n]) => chip('verdict', k, n, verdictCounts[k])).join('')}
    </div>
    <div class="want-bar" id="want-bar" hidden><span class="hint">Get an email when any of these drops in price</span><button class="btn primary" id="watch-want">Watch all prices</button></div>
    <div class="grid" id="grid"></div>
    <section id="online" hidden></section>`;

  const grid = app.querySelector('#grid');
  const wantBar = app.querySelector('#want-bar');
  wantBar.querySelector('#watch-want').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      const { watches } = await api('/watches');
      const list = wantToWatch(watches);
      const ok = await watchAll(list);
      toast(list.length ? `Watching ${ok} more item${ok === 1 ? '' : 's'}` : 'All “Want” items are already watched');
    } catch (e) {
      toast(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Watch all prices';
    }
  });
  const draw = () => {
    const q = f.q.trim().toLowerCase();
    const list = entries.filter((e) => {
      if (f.cat !== 'all' && (e.category || 'other') !== f.cat) return false;
      if (f.verdict !== 'all' && e.verdict !== f.verdict) return false;
      if (!q) return true;
      const hay = [e.product?.name, e.product?.productId, e.product?.code, e.color, e.size, e.store, e.pros, e.notes, (e.tags || []).join(' '), (e.product?.category || []).join(' ')]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
    app.querySelector('#count').textContent = `${list.length} ${list.length === 1 ? 'item' : 'items'}`;
    wantBar.hidden = f.verdict !== 'want';
    grid.innerHTML = list.length
      ? list.map(cardHtml).join('')
      : `<p class="empty" style="grid-column:1/-1;padding:32px 16px">${q ? 'No matching items' : 'No items in this filter'}</p>`;
  };
  draw();

  // 同时在 uniqlo.com 搜索：停止输入一会儿再搜，回车立即搜；点结果直接去记录
  const online = app.querySelector('#online');
  let timer;
  let seq = 0;
  const searchOnline = async (q) => {
    clearTimeout(timer);
    const my = ++seq;
    if (q.length < 2) {
      online.hidden = true;
      return;
    }
    online.hidden = false;
    online.innerHTML = `<h2 class="online-head">On uniqlo.com</h2><div class="grid">${'<div class="card"><div class="thumb skeleton"></div></div>'.repeat(4)}</div>`;
    try {
      const { results, region, fallback } = await api(`/search?q=${encodeURIComponent(q)}`);
      if (my !== seq) return;
      online.innerHTML = `<h2 class="online-head">On uniqlo.com <span class="hint">${
        results.length ? `${results.length} results${fallback ? ` · from the ${esc(REGION_NAME[region] || region)} site` : ''}` : ''
      }</span></h2>${results.length ? resultCardsHtml(results) : `<p class="hint">No results for “${esc(q)}” on uniqlo.com.</p>`}`;
      online.querySelectorAll('.result').forEach((b) =>
        b.addEventListener('click', () => {
          location.hash = `#/new/${encodeURIComponent(`/products/${b.dataset.id}/${b.dataset.pg}`)}`;
        }),
      );
    } catch (e) {
      if (my === seq && e.status !== 401) online.innerHTML = `<h2 class="online-head">On uniqlo.com</h2><p class="error">${esc(e.message)}</p>`;
    }
  };
  const searchBox = app.querySelector('.search');
  searchBox.addEventListener('input', (ev) => {
    f.q = ev.target.value;
    draw();
    clearTimeout(timer);
    timer = setTimeout(() => searchOnline(f.q.trim()), 700);
  });
  searchBox.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') searchOnline(f.q.trim());
  });
  if (f.q.trim()) searchOnline(f.q.trim());
  app.querySelectorAll('.chip').forEach((b) =>
    b.addEventListener('click', () => {
      f[b.dataset.group] = b.dataset.key;
      app.querySelectorAll(`.chip[data-group="${b.dataset.group}"]`).forEach((x) => x.setAttribute('aria-pressed', x === b));
      draw();
    }),
  );
}

function cardHtml(e) {
  const p = e.product || {};
  const cap = [CAT_NAME[e.category], e.size, FIT[e.fit]].filter(Boolean).join(' · ');
  return `
    <a class="card" href="#/entry/${esc(e.id)}">
      <div class="thumb">${img(heroImage(e), p.name)}</div>
      <div class="body">
        ${colorDots(e)}
        <div class="cap">${esc(cap)}</div>
        <div class="name">${esc(p.name || p.productId)}</div>
        ${entryPriceHtml(e)}
        ${e.verdict ? `<div class="flag ${esc(e.verdict)}">${VERDICT[e.verdict]}</div>` : ''}
        <div class="meta">${stars(e.rating)}<span>${e.triedAt ? esc(e.triedAt) : ''}</span></div>
      </div>
    </a>`;
}

// ---------- 新建 ----------

async function renderNew(prefill) {
  app.innerHTML = `
    <a class="back" href="#/">‹ Back</a>
    ${pageHead('Add a new', 'item')}
    <section class="panel">
      <h2>Find a product</h2>
      <form id="lookup" class="lookup">
        <input type="text" name="pid" inputmode="text" placeholder="6-digit number, product link or name" value="${esc(prefill.replace(/^\/products\/([^/]+)\/\d{2}$/, '$1'))}" required autocomplete="off">
        <button class="btn primary" id="go">Search</button>
      </form>
      <p class="hint">The number is on the tag (“Art. No.”) or the product page. You can also type an English product name, e.g. baggy barrel leg jeans.</p>
      <p class="error" id="err" hidden></p>
    </section>
    <div id="form-slot"></div>`;

  const form = app.querySelector('#lookup');
  const err = app.querySelector('#err');
  const slot = app.querySelector('#form-slot');
  const go = app.querySelector('#go');

  const busy = (on) => {
    go.disabled = on;
    go.textContent = on ? 'Searching…' : 'Search';
  };

  // 按编号/链接查询
  const lookup = async (input) => {
    err.hidden = true;
    busy(true);
    slot.innerHTML = `<section class="panel"><div class="product"><div class="hero skeleton"></div><div><div class="skeleton" style="height:18px;margin-bottom:8px"></div><div class="skeleton" style="height:14px;width:60%"></div></div></div></section>`;
    try {
      const { product } = await api(`/product/${encodeURIComponent(input)}`);
      const entries = await loadEntries().catch(() => []);
      const previous = entries.filter((e) => e.product?.productId === product.productId);
      renderForm(slot, { product, category: guessCategory(product), triedAt: today() }, { previous });
    } catch (e) {
      if (e.status === 401) return;
      err.hidden = false;
      err.textContent = e.message;
      const code = (input.match(/\d{6}/) || [''])[0];
      slot.innerHTML = '';
      if (e.status === 404 || e.status >= 500) {
        slot.innerHTML = `<section class="panel">
            ${e.status === 404 ? '<p style="margin:0 0 10px">Tag numbers sometimes differ from the website. Try searching by the English product name above.</p>' : ''}
            <p style="margin:0 0 10px">Or log it manually:</p><button class="btn" id="manual">Enter product details manually</button></section>`;
        slot.querySelector('#manual').addEventListener('click', () =>
          renderForm(slot, {
            product: { productId: e.body?.productId || (code ? `E${code}-000` : input), code, name: '', category: [], images: [], colors: [], sizes: [], source: 'manual' },
            category: 'other',
            triedAt: today(),
          }),
        );
      }
    } finally {
      busy(false);
    }
  };

  // 按名称搜索，点结果再按编号查询
  const search = async (q) => {
    err.hidden = true;
    busy(true);
    slot.innerHTML = `<div class="grid" style="margin-top:20px">${'<div class="card"><div class="thumb skeleton"></div></div>'.repeat(4)}</div>`;
    try {
      const { results, region, fallback } = await api(`/search?q=${encodeURIComponent(q)}`);
      if (!results.length) {
        slot.innerHTML = `<section class="panel"><p style="margin:0">No results for “${esc(q)}”. The site uses English names — try other words, e.g. wide pants or oversized shirt.</p></section>`;
        return;
      }
      slot.innerHTML = `
        <section class="panel">
          <h2>Pick a product <span class="hint" style="font-weight:400">${results.length} results${fallback ? ` · from the ${esc(REGION_NAME[region] || region)} site` : ''}</span></h2>
          ${resultCardsHtml(results)}
        </section>`;
      slot.querySelectorAll('.result').forEach((b) =>
        b.addEventListener('click', () => {
          scrollTo({ top: 0 });
          lookup(`/products/${b.dataset.id}/${b.dataset.pg}`);
        }),
      );
    } catch (e) {
      if (e.status === 401) return;
      slot.innerHTML = '';
      err.hidden = false;
      err.textContent = e.message;
    } finally {
      busy(false);
    }
  };

  // 有 6 位数字就当编号/链接查，否则按名称搜
  const run = () => {
    const raw = form.pid.value.trim();
    if (!raw) return;
    return /\d{6}/.test(raw) ? lookup(raw) : search(raw);
  };

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    run();
  });
  // 从搜索结果点进来时 prefill 是 /products/<编号>/<priceGroup>，输入框只显示编号，查询时仍带上 priceGroup
  if (prefill) /\d{6}/.test(prefill) ? lookup(prefill) : run();
  else form.pid.focus();
}

async function renderEdit(id) {
  const entries = await loadEntries();
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error('Record not found');
  app.innerHTML = `<a class="back" href="#/entry/${esc(id)}">‹ Back</a><div id="form-slot"></div>`;
  renderForm(app.querySelector('#form-slot'), structuredClone(entry), { editing: true });
}

// 常用短语：把以前填过的内容按逗号拆开，按用过的次数排序，点一下就能填进去（类似外卖备注）
const PHRASE_SEP = /[,，、;；\n]+/;
const STARTER_PHRASES = {
  pros: ['Great fit', 'Comfy fabric', 'Nice color', 'Flattering', 'Not see-through', 'Good value'],
  notes: ['Wide shoulders', 'Long sleeves', 'A bit sheer', 'Pills easily', 'Wrinkles easily', 'Static'],
  tags: ['work', 'layering', 'wait for sale'],
};

function splitPhrases(v) {
  return (Array.isArray(v) ? v : String(v || '').split(PHRASE_SEP)).map((s) => s.trim()).filter(Boolean);
}

function numOrNull(v) {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// 从别国官网查到的商品：标明来源站点，外币价格只作参考
function refPriceText(p) {
  const r = p.refPrice;
  if (!r) return '';
  const now = price(r);
  return r.base > r.value ? `${now} (was ${price({ value: r.base, currency: r.currency })})` : now;
}

// uniqlo.com 搜索结果格子（新建页和首页共用），点了按编号查询
function resultCardsHtml(results) {
  return `<div class="grid">${results
    .map(
      (r) => `<button type="button" class="card result" data-id="${esc(r.productId)}" data-pg="${esc(r.priceGroup)}">
        <div class="thumb">${r.image ? img(r.image, r.name) : ''}</div>
        <div class="body">
          <div class="cap">${esc(r.productId.replace(/^E/, '').replace(/-000$/, ''))}</div>
          <div class="name">${esc(r.name)}</div>
          ${r.price ? `<div class="price${(r.flags || []).includes('Reduced Price') ? ' sale' : ''}"><b>${esc(r.price)}</b></div>` : ''}
          ${r.flags?.length ? `<div class="cap">${esc(r.flags.join(' · '))}</div>` : ''}
        </div>
      </button>`,
    )
    .join('')}</div>`;
}

// 价格块：比原价便宜时折后价标红、原价划线，并标出折扣
function priceHtml(paid, original, currency, cls = '') {
  const now = price({ value: paid, currency });
  if (!now) return '';
  const sale = original > paid;
  return `<div class="price ${cls}${sale ? ' sale' : ''}"><b>${esc(now)}</b>${
    sale ? `<s>${esc(price({ value: original, currency }))}</s><span class="off">-${Math.round((1 - paid / original) * 100)}%</span>` : ''
  }</div>`;
}

// 记录的价格：优先用自己填的购买价/原价，没填就用当时的官网价
function entryPriceHtml(e, cls) {
  const p = e.product || {};
  return priceHtml(e.paidPrice ?? p.price?.value, e.originalPrice ?? p.basePrice?.value, e.currency || p.price?.currency, cls);
}

// 官网色块小方格，试穿的颜色加框
function colorDots(e) {
  const colors = (e.product?.colors || []).filter((c) => c.chip);
  if (!colors.length) return '';
  const tried = String(e.color || '').split(' ')[0];
  return `<div class="colors">${colors
    .slice(0, 6)
    .map((c) => `<img src="${esc(c.chip)}" alt="${esc(c.name)}" title="${esc(`${c.code} ${c.name}`)}" class="${c.code === tried ? 'on' : ''}" loading="lazy" referrerpolicy="no-referrer">`)
    .join('')}${colors.length > 6 ? `<span>+${colors.length - 6}</span>` : ''}</div>`;
}

function phraseSuggestions(field) {
  const count = new Map();
  for (const e of state.entries || [])
    for (const s of new Set(splitPhrases(e[field]))) if (s.length <= 20) count.set(s, (count.get(s) || 0) + 1);
  const used = [...count].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  // 自己的常用语攒够之前，先给几个示例
  return [...new Set(used.length < 6 ? [...used, ...STARTER_PHRASES[field]] : used)].slice(0, 30);
}

// ---------- 记录表单（新建/编辑共用） ----------

function renderForm(slot, entry, { previous = [], editing = false } = {}) {
  const p = entry.product;
  const manual = p.source === 'manual' || !p.name;
  const colorOpts = (p.colors || []).map((c) => `${c.code} ${c.name}`.trim());
  const colorChips = Object.fromEntries((p.colors || []).map((c) => [`${c.code} ${c.name}`.trim(), c.chip]));
  const sizeOpts = p.sizes?.length ? p.sizes : DEFAULT_SIZES;
  const stores = [...new Set((state.entries || []).map((e) => e.store).filter(Boolean))];
  // 购买价默认是当时官网售价（有折扣就是折后价），原价默认是官网没打折的价格
  const currency = entry.currency || p.price?.currency || p.basePrice?.currency || 'SEK';
  const paidPrice = entry.paidPrice ?? p.price?.value ?? '';
  const originalPrice = entry.originalPrice ?? p.basePrice?.value ?? p.price?.value ?? '';

  const seg = (name, map, value) =>
    `<div class="seg" role="radiogroup">${Object.entries(map)
      .map(([k, v]) => `<label><input type="radio" name="${name}" value="${k}" ${value === k ? 'checked' : ''}><span>${v}</span></label>`)
      .join('')}</div>`;

  const phrases = (name) =>
    `<div class="phrases" data-for="${name}">${phraseSuggestions(name)
      .map((t) => `<button type="button" data-t="${esc(t)}">${esc(t)}</button>`)
      .join('')}</div>`;

  // 点选的选项 + 一个「其他」输入框（选项里没有时再手打）
  const picker = (name, opts, value, placeholder, chips = {}) => {
    const other = value && !opts.includes(value) ? value : '';
    const dot = (o) => (chips[o] ? `<img class="dot" src="${esc(chips[o])}" alt="" referrerpolicy="no-referrer">` : '');
    return `<div class="pick" role="radiogroup">
      ${opts.map((o) => `<label><input type="radio" name="${name}" value="${esc(o)}" ${o === value ? 'checked' : ''}><span>${dot(o)}${esc(o)}</span></label>`).join('')}
      <input type="text" name="${name}_other" value="${esc(other)}" placeholder="${placeholder}" aria-label="Other ${name === 'size' ? 'size' : 'color'}">
    </div>`;
  };

  slot.innerHTML = `
    <section class="panel">
      <div class="product">
        <div class="hero" id="hero">${img(heroImage(entry), p.name)}</div>
        <div>
          <h3>${esc(p.name || '(Unnamed product)')}</h3>
          <div class="sub">
            <span>${esc(p.productId)}</span>
            ${p.category?.length ? `<span>${esc(p.category.join(' › '))}</span>` : ''}
            ${priceHtml(p.price?.value, p.basePrice?.value, p.price?.currency)}
            ${p.region ? `<span>Not listed on your site — details from the ${esc(REGION_NAME[p.region] || p.region)} site${p.refPrice ? `, reference price ${esc(refPriceText(p))}` : ''}</span>` : ''}
            ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">Product page ↗</a>` : ''}
          </div>
          ${previous.length ? `<p class="hint">Already in your closet ${previous.length === 1 ? 'once' : `${previous.length} times`}: ${previous.map((e) => `<a href="#/entry/${esc(e.id)}">${esc(e.triedAt || '')} ${esc(e.size || '')}</a>`).join(', ')}</p>` : ''}
        </div>
      </div>
      ${
        (p.images || []).some((i) => i.color)
          ? `<div class="swatches" role="group" aria-label="Choose color">${p.images
              .filter((i) => i.color)
              .map((i) => {
                const c = (p.colors || []).find((c) => c.code === i.color || i.color.endsWith(c.code));
                const label = c ? `${c.code} ${c.name}`.trim() : i.color;
                return `<button type="button" data-color="${esc(label)}" aria-pressed="${entry.color === label}" title="${esc(label)}">${img(i, label)}</button>`;
              })
              .join('')}</div>`
          : ''
      }
    </section>

    <form class="panel" id="entry-form">
      <h2>${editing ? 'Edit item' : 'My notes'}</h2>
      <div class="fields">
        ${
          manual
            ? `<label class="field full"><span>Product name</span><input type="text" name="p_name" value="${esc(p.name)}" required></label>
               <label class="field full"><span>Image URL (optional)</span><input type="url" name="p_image" value="${esc(p.images?.[0]?.url || '')}" placeholder="https://image.uniqlo.com/…"></label>`
            : ''
        }
        <label class="field"><span>Category</span>
          <select name="category">${CATEGORIES.map(([k, n]) => `<option value="${k}" ${entry.category === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </label>
        <label class="field"><span>Date</span><input type="date" name="triedAt" value="${esc(entry.triedAt || '')}"></label>
        <div class="field full"><span>Color</span>${picker('color', colorOpts, entry.color || '', colorOpts.length ? 'Other' : 'e.g. 09 BLACK', colorChips)}</div>
        <div class="field full"><span>Size</span>${picker('size', sizeOpts, entry.size || '', 'Other')}</div>
        <div class="field full"><span>Fit</span>${seg('fit', FIT, entry.fit)}</div>
        <div class="field full"><span>Length</span>${seg('length', LENGTH, entry.length)}</div>
        <div class="field"><span>Rating</span>
          <div class="star-input" id="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" aria-label="${n} stars" class="${n <= (entry.rating || 0) ? 'on' : ''}">★</button>`).join('')}</div>
        </div>
        <label class="field"><span>Store</span>
          <input type="text" name="store" value="${esc(entry.store || '')}" list="stores" placeholder="e.g. Drottninggatan">
          <datalist id="stores">${stores.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
        </label>
        <div class="field full" id="verdict-field"><span>Verdict <b class="req">*</b></span>${seg('verdict', VERDICT, entry.verdict)}<p class="error" id="verdict-err" hidden>Please choose a verdict</p></div>
        <label class="field"><span>Original price (${esc(currency)})</span><input type="number" name="originalPrice" value="${esc(originalPrice)}" min="0" step="any" inputmode="decimal"></label>
        <label class="field"><span>Price paid (${esc(currency)})</span><input type="number" name="paidPrice" value="${esc(paidPrice)}" min="0" step="any" inputmode="decimal"></label>
        <div class="field full"><label for="f-pros">What I liked</label><textarea id="f-pros" name="pros" placeholder="Fit, fabric, color…">${esc(entry.pros || '')}</textarea>${phrases('pros')}</div>
        <div class="field full"><label for="f-notes">Dislikes / notes</label><textarea id="f-notes" name="notes" placeholder="Shoulders, sleeve length, sheerness, pilling…">${esc(entry.notes || '')}</textarea>${phrases('notes')}</div>
        <div class="field full"><label for="f-tags">Tags (comma separated)</label><input type="text" id="f-tags" name="tags" value="${esc((entry.tags || []).join(', '))}" placeholder="work, layering, wait for sale">${phrases('tags')}</div>
      </div>
      <p class="error" id="save-err" hidden></p>
      <div class="actions">
        <a class="btn" href="${editing ? `#/entry/${esc(entry.id)}` : '#/'}">Cancel</a>
        <button class="btn primary" id="save">Save</button>
      </div>
    </form>`;

  const form = slot.querySelector('#entry-form');
  let rating = entry.rating || 0;

  slot.querySelectorAll('#stars button').forEach((b) =>
    b.addEventListener('click', () => {
      const n = Number(b.dataset.n);
      rating = rating === n ? 0 : n;
      slot.querySelectorAll('#stars button').forEach((x) => x.classList.toggle('on', Number(x.dataset.n) <= rating));
    }),
  );

  // 点颜色缩略图：切换主图并填入颜色
  slot.querySelectorAll('.swatches button').forEach((b) =>
    b.addEventListener('click', () => {
      const label = b.dataset.color;
      slot.querySelectorAll('.swatches button').forEach((x) => x.setAttribute('aria-pressed', x === b));
      slot.querySelector('#hero').innerHTML = b.innerHTML;
      const radio = [...form.querySelectorAll('input[name=color]')].find((r) => r.value === label);
      if (radio) {
        radio.checked = true;
        form.color_other.value = '';
      } else {
        form.querySelectorAll('input[name=color]').forEach((r) => (r.checked = false));
        form.color_other.value = label;
      }
    }),
  );

  // 常用短语：点一下加到末尾，已经填了的再点一下就去掉
  slot.querySelectorAll('.phrases').forEach((box) => {
    const input = form.elements[box.dataset.for];
    const joiner = ', ';
    const sync = () => {
      const have = new Set(splitPhrases(input.value));
      box.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', have.has(b.dataset.t)));
    };
    box.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      const t = b.dataset.t;
      const list = splitPhrases(input.value);
      input.value = (list.includes(t) ? list.filter((x) => x !== t) : [...list, t]).join(joiner);
      sync();
    });
    input.addEventListener('input', sync);
    sync();
  });

  form.querySelectorAll('input[name=verdict]').forEach((r) => r.addEventListener('change', () => (form.querySelector('#verdict-err').hidden = true)));

  // 选了选项就清空「其他」，在「其他」里打字就取消选项
  for (const name of ['color', 'size']) {
    const other = form.elements[`${name}_other`];
    form.querySelectorAll(`input[name=${name}]`).forEach((r) =>
      r.addEventListener('change', () => {
        other.value = '';
        if (name === 'color') [...slot.querySelectorAll('.swatches button')].find((x) => x.dataset.color === r.value)?.click();
      }),
    );
    other.addEventListener('input', () => {
      if (other.value) form.querySelectorAll(`input[name=${name}]`).forEach((r) => (r.checked = false));
    });
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    // 结论必选
    if (!fd.get('verdict')) {
      form.querySelector('#verdict-err').hidden = false;
      form.querySelector('#verdict-field').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const product = { ...p };
    if (manual) {
      product.name = fd.get('p_name').trim();
      const u = fd.get('p_image').trim();
      product.images = u ? [{ url: u, color: null }] : [];
    }
    const data = {
      product,
      category: fd.get('category'),
      triedAt: fd.get('triedAt') || '',
      color: fd.get('color') || String(fd.get('color_other') || '').trim(),
      size: fd.get('size') || String(fd.get('size_other') || '').trim(),
      fit: fd.get('fit') || '',
      length: fd.get('length') || '',
      rating,
      store: (fd.get('store') || '').trim(),
      verdict: fd.get('verdict') || '',
      originalPrice: numOrNull(fd.get('originalPrice')),
      paidPrice: numOrNull(fd.get('paidPrice')),
      currency,
      pros: (fd.get('pros') || '').trim(),
      notes: (fd.get('notes') || '').trim(),
      tags: String(fd.get('tags') || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    };
    const btn = slot.querySelector('#save');
    const err = slot.querySelector('#save-err');
    btn.disabled = true;
    err.hidden = true;
    try {
      const res = editing
        ? await api(`/entries/${encodeURIComponent(entry.id)}`, { method: 'PUT', body: data })
        : await api('/entries', { method: 'POST', body: data });
      upsertLocal(res.entry);
      toast('Saved');
      // 新建完回到「我的试穿」列表；编辑完回到这条记录的详情
      location.hash = editing ? `#/entry/${res.entry.id}` : '#/';
    } catch (e) {
      err.hidden = false;
      err.textContent = `Couldn't save: ${e.message}`;
      btn.disabled = false;
    }
  });
}

// ---------- 详情 ----------

async function renderDetail(id) {
  const entries = await loadEntries();
  const e = entries.find((x) => x.id === id);
  if (!e) throw new Error('Record not found');
  const p = e.product || {};
  const hero = heroImage(e);
  const gallery = [hero, ...(p.images || []).filter((i) => i !== hero)].filter(Boolean).slice(0, 12);
  const related = entries.filter((x) => x.id !== e.id && x.product?.productId === p.productId);

  const row = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : '');
  app.innerHTML = `
    <a class="back" href="#/">‹ My closet</a>
    <article class="detail">
      <div class="detail-hero">
        ${gallery.length ? `<div class="gallery">${gallery.map((i) => img(i, p.name)).join('')}</div>` : ''}
        <div>
          <h1>${esc(p.name || p.productId)}</h1>
          <p class="pid">Product no. ${esc(p.code || p.productId)}${p.category?.length ? ` · ${esc(p.category.join(' › '))}` : ''}</p>
          ${entryPriceHtml(e, 'big')}
          <div class="tags-row">
            ${e.verdict ? `<span class="badge ${esc(e.verdict)}">${VERDICT[e.verdict]}</span>` : ''}
            <span class="badge">${esc(CAT_NAME[e.category] || 'Other')}</span>
            ${stars(e.rating)}
          </div>
          <section class="panel">
            <h2>My notes</h2>
            <dl class="kv">
              ${row('Date', esc(e.triedAt))}
              ${row('Store', esc(e.store))}
              ${row('Color', esc(e.color))}
              ${row('Size', esc(e.size))}
              ${row('Fit', FIT[e.fit] || '')}
              ${row('Length', LENGTH[e.length] || '')}
              ${row('Original price', esc(price({ value: e.originalPrice, currency: e.currency })))}
              ${row('Price paid', esc(price({ value: e.paidPrice, currency: e.currency })))}
              ${row('Tags', esc((e.tags || []).join(', ')))}
            </dl>
          </section>
          ${e.pros ? `<section class="panel"><h2>What I liked</h2><p class="note">${esc(e.pros)}</p></section>` : ''}
          ${e.notes ? `<section class="panel"><h2>Dislikes / notes</h2><p class="note">${esc(e.notes)}</p></section>` : ''}
          <section class="panel">
            <h2>Product info</h2>
            <dl class="kv">
              ${row('Product ID', esc(p.productId))}
              ${row('Site category', esc((p.category || []).join(' › ')))}
              ${row('Site price', esc(price(p.price)))}
              ${row('Source', p.region ? `${esc(REGION_NAME[p.region] || p.region)} site` : '')}
              ${row('Reference price', esc(refPriceText(p)))}
              ${row('Material', esc(p.composition))}
              ${row('Website', p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">Open product page ↗</a>` : '')}
            </dl>
          </section>
          ${canWatch(p) ? '<section class="panel" id="watch-panel"><h2>Price alert</h2><p class="hint" style="margin:0">Loading…</p></section>' : ''}
          ${
            related.length
              ? `<section class="panel"><h2>Other entries for this item</h2><div class="related">${related
                  .map((r) => `<a href="#/entry/${esc(r.id)}"><span>${esc(r.triedAt || '')} · ${esc(r.size || '')} ${esc(r.color || '')}</span><span>${FIT[r.fit] || ''}</span></a>`)
                  .join('')}</div></section>`
              : ''
          }
          <div class="actions">
            <button class="btn danger" id="del">Delete</button>
            <a class="btn" href="#/new/${encodeURIComponent(p.productId || '')}">Log again</a>
            <a class="btn primary" href="#/edit/${esc(e.id)}">Edit</a>
          </div>
        </div>
      </div>
    </article>`;

  const wp = app.querySelector('#watch-panel');
  if (wp) drawWatchPanel(wp, p);

  app.querySelector('#del').addEventListener('click', async () => {
    if (!confirm('Delete this item?')) return;
    try {
      await api(`/entries/${encodeURIComponent(e.id)}`, { method: 'DELETE' });
      state.entries = state.entries.filter((x) => x.id !== e.id);
      safeSet(CACHE_KEY, JSON.stringify(state.entries));
      toast('Deleted');
      location.hash = '#/';
    } catch (err) {
      toast(`Couldn't delete: ${err.message}`);
    }
  });
}

// ---------- 降价提醒 ----------

// 只有本站官网查到的商品能跟踪价格（手动填写的、别国站点的不行）
function canWatch(p) {
  return p && p.source === 'api' && !p.region && /^[A-Z]\d{6}-\d{3}$/.test(p.productId || '');
}

// 「Checked 3 h ago」/「Not checked yet」
function checkedText(ts) {
  if (!ts) return 'Not checked yet';
  const m = Math.round((Date.now() - ts) / 60000);
  const ago = m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 60 * 24 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 60 / 24)} d ago`;
  return `Checked ${ago}`;
}

// 详情页里的降价提醒：关注/取消关注，可设目标价
async function drawWatchPanel(el, p) {
  let w = null;
  try {
    w = (await api(`/watches/${encodeURIComponent(p.productId)}`)).watch;
  } catch (e) {
    if (e.status !== 404) {
      el.innerHTML = `<h2>Price alert</h2><p class="error">${esc(e.message)}</p>`;
      return;
    }
  }
  const cur = p.price?.currency || 'SEK';
  el.innerHTML = `
    <h2>Price alert</h2>
    ${
      w
        ? `<p style="margin:0 0 4px">Watching · latest price <b>${esc(price({ value: w.lastPrice, currency: w.currency || cur }))}</b>${
            w.lowestPrice != null && w.lowestPrice < w.lastPrice ? `, lowest seen ${esc(price({ value: w.lowestPrice, currency: w.currency || cur }))}` : ''
          }</p>
           <p class="hint" style="margin:0 0 12px">${esc(checkedText(w.lastChecked))} · you'll get an email when the price drops (<a href="#/watch">manage</a>)</p>`
        : '<p class="hint" style="margin:0 0 12px">Checks the uniqlo.com price every few hours and emails you when it drops.</p>'
    }
    <form class="lookup" id="watch-form">
      <input type="number" name="target" min="0" step="any" inputmode="decimal" placeholder="Target price (optional, ${esc(cur)})" value="${esc(w?.targetPrice ?? '')}" aria-label="Target price">
      <button class="btn ${w ? '' : 'primary'}">${w ? 'Save' : 'Watch price'}</button>
    </form>
    <p class="hint">${w ? '' : 'No target: alert on any drop. With a target: alert only at or below it.'}</p>
    ${w ? '<div class="actions" style="justify-content:flex-start;margin-top:8px"><button class="btn danger" id="unwatch">Stop watching</button></div>' : ''}`;

  el.querySelector('#watch-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const target = ev.target.target.value;
    try {
      await api(`/watches/${encodeURIComponent(p.productId)}`, {
        method: 'PUT',
        body: { targetPrice: target, name: p.name, image: p.images?.[0]?.url, url: p.url, currency: p.price?.currency, price: p.price?.value, basePrice: p.basePrice?.value },
      });
      toast(w ? 'Saved' : "Watching — you'll get an email when it drops");
      drawWatchPanel(el, p);
    } catch (e) {
      toast(`Failed: ${e.message}`);
    }
  });
  el.querySelector('#unwatch')?.addEventListener('click', async () => {
    await api(`/watches/${encodeURIComponent(p.productId)}`, { method: 'DELETE' }).catch(() => {});
    toast('Stopped watching');
    drawWatchPanel(el, p);
  });
}

// 一键关注所有「想买」的商品（已经关注的、不能跟踪价格的跳过）
function wantToWatch(watches) {
  const watched = new Set(watches.map((w) => w.productId));
  const seen = new Set();
  return (state.entries || []).filter((e) => {
    const id = e.product?.productId;
    if (e.verdict !== 'want' || !canWatch(e.product) || watched.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function watchAll(list) {
  let ok = 0;
  for (const e of list) {
    const p = e.product;
    try {
      await api(`/watches/${encodeURIComponent(p.productId)}`, {
        method: 'PUT',
        body: { name: p.name, image: heroImage(e)?.url || p.images?.[0]?.url, url: p.url, currency: p.price?.currency, price: p.price?.value, basePrice: p.basePrice?.value },
      });
      ok++;
    } catch {}
  }
  return ok;
}

async function renderWatch() {
  app.innerHTML = `${pageHead('Price', 'alerts')}<p class="hint">Loading…</p>`;
  const [{ watches, email }] = await Promise.all([api('/watches'), loadEntries().catch(() => [])]);
  const ready = email.to && email.keyConfigured;
  const pending = wantToWatch(watches);

  app.innerHTML = `
    ${pageHead('Price', 'alerts', `<span class="count">${watches.length} ${watches.length === 1 ? 'item' : 'items'}</span>`)}
    <section class="panel">
      <h2>Alert email</h2>
      <form class="lookup" id="email-form">
        <input type="email" name="email" value="${esc(email.to || '')}" placeholder="you@example.com" autocomplete="email" required>
        <button class="btn">Save</button>
      </form>
      ${
        email.keyConfigured
          ? `<p class="hint">Email service is set up.${email.to ? '<button class="btn" id="test-email" style="min-height:32px;padding:0 12px;margin-left:6px">Send a test email</button>' : ''}</p>`
          : `<p class="hint">One more step: the server doesn't have a <code>RESEND_API_KEY</code> yet (see the README). Until then prices are tracked but no emails are sent.</p>`
      }
      <p class="hint">A free Resend account without its own domain can only send to the address you signed up with, so use that same address here.</p>
    </section>
    <section class="panel">
      <h2 style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">Watching
        <span style="display:flex;gap:8px">
          ${pending.length ? `<button class="btn primary" id="watch-want" style="min-height:32px;padding:0 12px">Watch all “Want” (${pending.length})</button>` : ''}
          ${watches.length ? '<button class="btn" id="check-now" style="min-height:32px;padding:0 12px">Check now</button>' : ''}
        </span></h2>
      ${
        watches.length
          ? `<div class="grid">${watches.map(watchCard).join('')}</div>
             <p class="hint" style="margin-top:20px">A batch is checked every hour (4 items at a time, in rotation), so with many items each one is checked every few hours.${ready ? '' : ' <b>Email isn’t set up yet, so drops won’t be sent.</b>'}</p>`
          : '<p class="hint" style="margin:0">Nothing watched yet. Open any item in your closet and tap “Watch price” at the bottom, or watch everything marked “Want” in one tap.</p>'
      }
    </section>`;

  app.querySelector('#email-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/settings', { method: 'PUT', body: { alertEmail: ev.target.email.value.trim() } });
      toast('Saved');
      renderWatch();
    } catch (e) {
      toast(e.message);
    }
  });
  app.querySelector('#test-email')?.addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    try {
      await api('/watches/test-email', { method: 'POST' });
      toast('Sent — check your inbox (and spam folder)');
    } catch (e) {
      toast(`Couldn't send: ${e.body?.error || e.message}`);
    } finally {
      ev.target.disabled = false;
    }
  });
  app.querySelector('#watch-want')?.addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    ev.target.textContent = 'Adding…';
    const ok = await watchAll(pending);
    toast(`Watching ${ok} more item${ok === 1 ? '' : 's'}`);
    renderWatch();
  });
  app.querySelector('#check-now')?.addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    ev.target.textContent = 'Checking…';
    try {
      const r = await api('/watches/check', { method: 'POST', body: {} });
      toast(
        r.notified
          ? `${r.notified} price drop${r.notified === 1 ? '' : 's'}${r.email?.ok ? ' — email sent' : r.email ? ` — email not sent: ${r.email.error}` : ''}`
          : `Checked ${r.checked.length}, no new drops`,
      );
      renderWatch();
    } catch (e) {
      toast(e.message);
      ev.target.disabled = false;
    }
  });
  app.querySelectorAll('[data-unwatch]').forEach((b) =>
    b.addEventListener('click', async (ev) => {
      ev.preventDefault();
      await api(`/watches/${encodeURIComponent(b.dataset.unwatch)}`, { method: 'DELETE' }).catch(() => {});
      toast('Stopped watching');
      renderWatch();
    }),
  );
}

function watchCard(w) {
  const entry = (state.entries || []).find((e) => e.product?.productId === w.productId);
  const href = entry ? `#/entry/${esc(entry.id)}` : esc(w.url || '#/watch');
  return `
    <a class="card" href="${href}" ${entry ? '' : 'target="_blank" rel="noopener"'}>
      <div class="thumb">${w.image ? img(w.image, w.name) : ''}</div>
      <div class="body">
        <div class="cap">${esc(w.productId.replace(/^E/, '').replace(/-000$/, ''))}</div>
        <div class="name">${esc(w.name || w.productId)}</div>
        ${priceHtml(w.lastPrice, w.basePrice, w.currency)}
        ${w.targetPrice != null ? `<div class="cap">Target ${esc(price({ value: w.targetPrice, currency: w.currency }))}${w.lastPrice != null && w.lastPrice <= w.targetPrice ? ' · <b style="color:var(--accent)">Reached</b>' : ''}</div>` : ''}
        ${w.saleColors?.length ? `<div class="cap">On sale: ${esc(w.saleColors.join(', '))}</div>` : ''}
        <div class="meta"><span>${esc(checkedText(w.lastChecked))}</span><button type="button" class="linkish" data-unwatch="${esc(w.productId)}">Stop watching</button></div>
      </div>
    </a>`;
}

// ---------- 设置 ----------

async function renderSettings() {
  const entries = await loadEntries().catch(() => state.entries || []);
  let info = null;
  let archive = null;
  try { [info, archive] = await Promise.all([api('/ping'), api('/archive')]); } catch {}
  const count = (k) => entries.filter((e) => e.verdict === k).length;

  app.innerHTML = `
    <a class="back" href="#/">‹ Back</a>
    ${pageHead('Your', 'settings')}
    <section class="panel">
      <h2>Overview</h2>
      <div class="stats">
        <div class="stat"><b>${entries.length}</b><span>Items</span></div>
        <div class="stat"><b>${new Set(entries.map((e) => e.product?.productId)).size}</b><span>Styles</span></div>
        <div class="stat"><b>${count('bought')}</b><span>Bought</span></div>
        <div class="stat"><b>${count('want')}</b><span>Want</span></div>
      </div>
      ${info ? `<p class="hint">Uniqlo site: ${esc(info.region)} / ${esc(info.lang)} (change it under vars in wrangler.jsonc)</p>` : ''}
    </section>
    <section class="panel">
      <h2>Image archive</h2>
      ${
        !archive
          ? '<p class="hint" style="margin:0">Couldn’t load archive status</p>'
          : !archive.enabled
            ? '<p class="hint" style="margin:0">Off: the server has no R2 bucket bound (see the README). Images load live from uniqlo.com and may disappear when a product is removed.</p>'
            : `<p style="margin:0 0 10px">Archived <b>${archive.archived}</b> / ${archive.total} product images</p>
               <p class="hint" style="margin:0 0 12px">Product images are copied to your own storage when you save an item, so they stay even if uniqlo.com removes them.</p>
               ${archive.archived < archive.total ? '<div class="actions" style="justify-content:flex-start"><button class="btn" id="backfill">Archive remaining images</button></div>' : ''}`
      }
    </section>
    <section class="panel">
      <h2>Backup</h2>
      <p class="hint" style="margin:0 0 12px">Export as a JSON file. Importing adds the records in the file as new items.</p>
      <div class="actions" style="justify-content:flex-start">
        <button class="btn" id="export">Export JSON</button>
        <label class="btn">Import JSON<input type="file" id="import" accept="application/json,.json" hidden></label>
      </div>
    </section>
    <section class="panel">
      <h2>Device</h2>
      <div class="actions" style="justify-content:flex-start">
        <button class="btn" id="refresh">Sync again</button>
        <button class="btn danger" id="logout">Log out</button>
      </div>
    </section>`;

  app.querySelector('#export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), entries }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fitlog-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  app.querySelector('#import').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data.entries || [];
      let ok = 0;
      for (const item of list) {
        if (!item?.product?.productId) continue;
        await api('/entries', { method: 'POST', body: item });
        ok++;
      }
      await loadEntries(true);
      toast(`Imported ${ok}`);
      renderSettings();
    } catch (e) {
      toast(`Import failed: ${e.message}`);
    }
  });

  app.querySelector('#backfill')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    let total = 0;
    try {
      // 每次请求最多处理 30 张，循环到没有进展为止
      for (;;) {
        btn.textContent = `Archiving… ${total} done`;
        const r = await api('/archive', { method: 'POST' });
        total += r.archived;
        if (!r.remaining || !r.archived) break;
      }
      await loadEntries(true);
      toast(`Archived ${total} new images`);
    } catch (e) {
      toast(`Archiving failed: ${e.message}`);
    }
    renderSettings();
  });

  app.querySelector('#refresh').addEventListener('click', async () => {
    await loadEntries(true);
    toast('Synced');
    renderSettings();
  });

  app.querySelector('#logout').addEventListener('click', () => {
    state.token = null;
    state.entries = null;
    safeSet(TOKEN_KEY, null);
    safeSet(CACHE_KEY, null);
    location.hash = '#/login';
  });
}

// ---------- 启动 ----------

// 浅色/深色切换：默认跟随系统，点一下改成另一种并记住
const themeBtn = document.getElementById('theme-btn');
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function drawThemeBtn() {
  const mode = document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');
  themeBtn.dataset.mode = mode;
  themeBtn.querySelector('span').textContent = mode === 'dark' ? 'Dark' : 'Light';
  const color = mode === 'dark' ? '#6a0c06' : '#ffffff';
  document.querySelectorAll('meta[name=theme-color]').forEach((m) => m.setAttribute('content', color));
}
themeBtn.addEventListener('click', () => {
  const next = themeBtn.dataset.mode === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  safeSet('fitlog.theme', next);
  drawThemeBtn();
});
darkQuery.addEventListener('change', drawThemeBtn);
drawThemeBtn();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
router();
