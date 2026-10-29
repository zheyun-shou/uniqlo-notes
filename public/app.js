// 试穿手记前端：无构建步骤的原生 JS，hash 路由。

const TOKEN_KEY = 'fitlog.token';
const CACHE_KEY = 'fitlog.entries';

const CATEGORIES = [
  // [key, 名称, 匹配优衣库分类/商品名的关键词（英文+瑞典语）]
  ['inner', '内衣/AIRism/HEATTECH', /innerwear|underwear|underkläder|\bbra\b|boxer|briefs|socks|strumpor/i],
  ['lounge', '家居服', /lounge|pajama|pyjamas|room ?wear|sleepwear|relaco/i],
  ['acc', '配饰/鞋包', /\bbags?\b|väska|\bhats?\b|\bcaps?\b|mössa|scarf|halsduk|gloves?|vantar|belts?|bälte|shoes|skor|accessor/i],
  ['skirt', '裙子/连衣裙', /skirts?|kjol|\bdress(es)?\b(?!\s*shirt)|klänning/i],
  ['pants', '裤子', /pants|trousers|byxa|byxor|jeans|chinos?|\bshorts\b|joggers?|leggings/i],
  ['down', '羽绒/棉服', /(?<![-\w])down\b|\bdun\b|puffer|padded|vadderad/i],
  ['outer', '外套/夹克', /jackets?|jacka|coats?|kappa|blousons?|\brock\b|blazer|parka|outerwear|ytterkläder|\bvests?\b|väst|gilet/i],
  ['knit', '针织/毛衣', /knit|sweaters?|cardigan|stickad|kofta|merino|cashmere|kashmir/i],
  ['sweat', '卫衣/抓绒', /sweatshirt|sweat|hoodie|huvtröja|fleece/i],
  ['tops', 'T恤/上衣', /t-?shirts?|\btees?\b|\btops?\b|topp|polo|tank|linne|airism|heattech/i],
  ['shirts', '衬衫', /shirts?|skjorta|blouse|blus/i],
  ['other', '其他', null],
];
const CAT_NAME = Object.fromEntries(CATEGORIES.map(([k, n]) => [k, n]));

const FIT = { small: '偏小', true: '合适', large: '偏大' };
// 官网没给出尺码列表时用的常见尺码
const DEFAULT_SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
const LENGTH = { short: '偏短', ok: '合适', long: '偏长' };
const VERDICT = { bought: '已购买', want: '想买', maybe: '再看看', pass: '不买' };

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

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function stars(n) {
  n = Number(n) || 0;
  if (!n) return '';
  return `<span class="stars" aria-label="${n} 星">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>`;
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
    super(body?.message || `请求失败（${status}）`);
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
    toast('离线中，显示的是上次同步的记录');
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
        if (e.status !== 401) app.innerHTML = `<div class="empty"><h2>出错了</h2><p>${esc(e.message)}</p><p><a class="btn" href="#/">回到首页</a></p></div>`;
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
      <h2>输入访问口令</h2>
      <p class="hint" style="margin:0 0 12px">口令就是部署时用 <code>wrangler secret put APP_TOKEN</code> 设置的值，只保存在这台设备上。</p>
      <form id="login" class="lookup">
        <input type="password" name="token" placeholder="APP_TOKEN" autocomplete="current-password" required>
        <button class="btn primary">进入</button>
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
      err.textContent = e.status === 401 ? '口令不正确' : e.message;
      if (e.status === 401) location.hash = '#/login';
    }
  });
  form.token.focus();
}

// ---------- 列表 ----------

async function renderList() {
  app.innerHTML = `<div class="grid">${'<div class="card"><div class="thumb skeleton"></div><div class="body"><div class="skeleton" style="height:14px"></div></div></div>'.repeat(4)}</div>`;
  const entries = await loadEntries();

  if (!entries.length) {
    app.innerHTML = `
      <div class="empty">
        <h2>还没有试穿记录</h2>
        <p>点右下角的 ＋，输入吊牌或官网上的 6 位商品编号开始记录。</p>
        <p><a class="btn primary" href="#/new">新建第一条</a></p>
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
    <div class="toolbar">
      <input class="search" type="search" placeholder="搜索名称、编号、备注…" value="${esc(f.q)}" aria-label="搜索">
      <div class="chips" role="group" aria-label="分类">
        ${chip('cat', 'all', '全部', entries.length)}
        ${CATEGORIES.filter(([k]) => catCounts[k]).map(([k, n]) => chip('cat', k, n, catCounts[k])).join('')}
      </div>
    </div>
    <div class="chips" role="group" aria-label="结论" style="margin:-4px 0 14px">
      ${chip('verdict', 'all', '所有结论')}
      ${Object.entries(VERDICT).filter(([k]) => verdictCounts[k]).map(([k, n]) => chip('verdict', k, n, verdictCounts[k])).join('')}
    </div>
    <div class="grid" id="grid"></div>`;

  const grid = app.querySelector('#grid');
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
    grid.innerHTML = list.length
      ? list.map(cardHtml).join('')
      : `<p class="empty" style="grid-column:1/-1">没有符合条件的记录</p>`;
  };
  draw();

  app.querySelector('.search').addEventListener('input', (ev) => {
    f.q = ev.target.value;
    draw();
  });
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
  const bits = [e.size && `尺码 ${e.size}`, e.fit && FIT[e.fit]].filter(Boolean).join(' · ');
  return `
    <a class="card" href="#/entry/${esc(e.id)}">
      <div class="thumb">
        ${img(heroImage(e), p.name)}
        ${e.verdict ? `<span class="badge ${esc(e.verdict)}">${VERDICT[e.verdict]}</span>` : ''}
      </div>
      <div class="body">
        <div class="name">${esc(p.name || p.productId)}</div>
        <div class="meta">${esc(bits || CAT_NAME[e.category] || '')}</div>
        <div class="meta">${stars(e.rating)} ${e.triedAt ? esc(e.triedAt) : ''}</div>
      </div>
    </a>`;
}

// ---------- 新建 ----------

async function renderNew(prefill) {
  app.innerHTML = `
    <a class="back" href="#/">‹ 返回</a>
    <section class="panel">
      <h2>查询商品</h2>
      <form id="lookup" class="lookup">
        <input type="text" name="pid" inputmode="text" placeholder="6 位编号，如 465185，或粘贴官网链接" value="${esc(prefill)}" required autocomplete="off">
        <button class="btn primary" id="go">查询</button>
      </form>
      <p class="hint">编号在吊牌上（“Art. No.”/商品编号）或官网商品页里。</p>
      <p class="error" id="err" hidden></p>
    </section>
    <div id="form-slot"></div>`;

  const form = app.querySelector('#lookup');
  const err = app.querySelector('#err');
  const slot = app.querySelector('#form-slot');
  const go = app.querySelector('#go');

  const run = async () => {
    const raw = form.pid.value.trim();
    if (!raw) return;
    err.hidden = true;
    go.disabled = true;
    go.textContent = '查询中…';
    slot.innerHTML = `<section class="panel"><div class="product"><div class="hero skeleton"></div><div><div class="skeleton" style="height:18px;margin-bottom:8px"></div><div class="skeleton" style="height:14px;width:60%"></div></div></div></section>`;
    try {
      const { product } = await api(`/product/${encodeURIComponent(raw)}`);
      const entries = await loadEntries().catch(() => []);
      const previous = entries.filter((e) => e.product?.productId === product.productId);
      renderForm(slot, { product, category: guessCategory(product), triedAt: today() }, { previous });
    } catch (e) {
      if (e.status === 401) return;
      err.hidden = false;
      err.textContent = e.message;
      const code = (raw.match(/\d{6}/) || [''])[0];
      slot.innerHTML = '';
      if (e.status === 404 || e.status >= 500) {
        slot.innerHTML = `<section class="panel"><p style="margin:0 0 10px">查不到也可以手动记录：</p><button class="btn" id="manual">手动填写商品信息</button></section>`;
        slot.querySelector('#manual').addEventListener('click', () =>
          renderForm(slot, {
            product: { productId: e.body?.productId || (code ? `E${code}-000` : raw), code, name: '', category: [], images: [], colors: [], sizes: [], source: 'manual' },
            category: 'other',
            triedAt: today(),
          }),
        );
      }
    } finally {
      go.disabled = false;
      go.textContent = '查询';
    }
  };

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    run();
  });
  if (prefill) run();
  else form.pid.focus();
}

async function renderEdit(id) {
  const entries = await loadEntries();
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error('找不到这条记录');
  app.innerHTML = `<a class="back" href="#/entry/${esc(id)}">‹ 返回</a><div id="form-slot"></div>`;
  renderForm(app.querySelector('#form-slot'), structuredClone(entry), { editing: true });
}

// ---------- 记录表单（新建/编辑共用） ----------

function renderForm(slot, entry, { previous = [], editing = false } = {}) {
  const p = entry.product;
  const manual = p.source === 'manual' || !p.name;
  const colorOpts = (p.colors || []).map((c) => `${c.code} ${c.name}`.trim());
  const colorChips = Object.fromEntries((p.colors || []).map((c) => [`${c.code} ${c.name}`.trim(), c.chip]));
  const sizeOpts = p.sizes?.length ? p.sizes : DEFAULT_SIZES;
  const stores = [...new Set((state.entries || []).map((e) => e.store).filter(Boolean))];

  const seg = (name, map, value) =>
    `<div class="seg" role="radiogroup">${Object.entries(map)
      .map(([k, v]) => `<label><input type="radio" name="${name}" value="${k}" ${value === k ? 'checked' : ''}><span>${v}</span></label>`)
      .join('')}</div>`;

  // 点选的选项 + 一个「其他」输入框（选项里没有时再手打）
  const picker = (name, opts, value, placeholder, chips = {}) => {
    const other = value && !opts.includes(value) ? value : '';
    const dot = (o) => (chips[o] ? `<img class="dot" src="${esc(chips[o])}" alt="" referrerpolicy="no-referrer">` : '');
    return `<div class="pick" role="radiogroup">
      ${opts.map((o) => `<label><input type="radio" name="${name}" value="${esc(o)}" ${o === value ? 'checked' : ''}><span>${dot(o)}${esc(o)}</span></label>`).join('')}
      <input type="text" name="${name}_other" value="${esc(other)}" placeholder="${placeholder}" aria-label="其他${name === 'size' ? '尺码' : '颜色'}">
    </div>`;
  };

  slot.innerHTML = `
    <section class="panel">
      <div class="product">
        <div class="hero" id="hero">${img(heroImage(entry), p.name)}</div>
        <div>
          <h3>${esc(p.name || '（未命名商品）')}</h3>
          <div class="sub">
            <span>${esc(p.productId)}</span>
            ${p.category?.length ? `<span>${esc(p.category.join(' › '))}</span>` : ''}
            ${price(p.price) ? `<span>${esc(price(p.price))}</span>` : ''}
            ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">官网页面 ↗</a>` : ''}
          </div>
          ${previous.length ? `<p class="hint">你之前试穿过这款 ${previous.length} 次：${previous.map((e) => `<a href="#/entry/${esc(e.id)}">${esc(e.triedAt || '')} ${esc(e.size || '')}</a>`).join('，')}</p>` : ''}
        </div>
      </div>
      ${
        (p.images || []).some((i) => i.color)
          ? `<div class="swatches" role="group" aria-label="选择颜色">${p.images
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
      <h2>${editing ? '编辑试穿记录' : '试穿反馈'}</h2>
      <div class="fields">
        ${
          manual
            ? `<label class="field full"><span>商品名称</span><input type="text" name="p_name" value="${esc(p.name)}" required></label>
               <label class="field full"><span>图片链接（可选）</span><input type="url" name="p_image" value="${esc(p.images?.[0]?.url || '')}" placeholder="https://image.uniqlo.com/…"></label>`
            : ''
        }
        <label class="field"><span>分类</span>
          <select name="category">${CATEGORIES.map(([k, n]) => `<option value="${k}" ${entry.category === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </label>
        <label class="field"><span>试穿日期</span><input type="date" name="triedAt" value="${esc(entry.triedAt || '')}"></label>
        <div class="field full"><span>颜色</span>${picker('color', colorOpts, entry.color || '', colorOpts.length ? '其他' : '如 09 BLACK', colorChips)}</div>
        <div class="field full"><span>试穿尺码</span>${picker('size', sizeOpts, entry.size || '', '其他')}</div>
        <div class="field full"><span>尺码感受</span>${seg('fit', FIT, entry.fit)}</div>
        <div class="field full"><span>长度</span>${seg('length', LENGTH, entry.length)}</div>
        <div class="field"><span>评分</span>
          <div class="star-input" id="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" aria-label="${n} 星" class="${n <= (entry.rating || 0) ? 'on' : ''}">★</button>`).join('')}</div>
        </div>
        <label class="field"><span>门店/地点</span>
          <input type="text" name="store" value="${esc(entry.store || '')}" list="stores" placeholder="如 Drottninggatan">
          <datalist id="stores">${stores.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
        </label>
        <div class="field full"><span>结论</span>${seg('verdict', VERDICT, entry.verdict)}</div>
        <label class="field full"><span>喜欢的地方</span><textarea name="pros" placeholder="版型、面料、颜色…">${esc(entry.pros || '')}</textarea></label>
        <label class="field full"><span>不满意 / 备注</span><textarea name="notes" placeholder="肩线、袖长、透不透、起不起球…">${esc(entry.notes || '')}</textarea></label>
        <label class="field full"><span>标签（逗号分隔）</span><input type="text" name="tags" value="${esc((entry.tags || []).join(', '))}" placeholder="通勤, 叠穿, 等打折"></label>
      </div>
      <p class="error" id="save-err" hidden></p>
      <div class="actions">
        <a class="btn" href="${editing ? `#/entry/${esc(entry.id)}` : '#/'}">取消</a>
        <button class="btn primary" id="save">保存</button>
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
      toast('已保存');
      location.hash = `#/entry/${res.entry.id}`;
    } catch (e) {
      err.hidden = false;
      err.textContent = `保存失败：${e.message}`;
      btn.disabled = false;
    }
  });
}

// ---------- 详情 ----------

async function renderDetail(id) {
  const entries = await loadEntries();
  const e = entries.find((x) => x.id === id);
  if (!e) throw new Error('找不到这条记录');
  const p = e.product || {};
  const hero = heroImage(e);
  const gallery = [hero, ...(p.images || []).filter((i) => i !== hero)].filter(Boolean).slice(0, 12);
  const related = entries.filter((x) => x.id !== e.id && x.product?.productId === p.productId);

  const row = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : '');
  app.innerHTML = `
    <a class="back" href="#/">‹ 全部记录</a>
    <article class="detail">
      <div class="detail-hero">
        ${gallery.length ? `<div class="gallery">${gallery.map((i) => img(i, p.name)).join('')}</div>` : ''}
        <div>
          <h1>${esc(p.name || p.productId)}</h1>
          <p style="margin:0 0 12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
            ${e.verdict ? `<span class="badge ${esc(e.verdict)}">${VERDICT[e.verdict]}</span>` : ''}
            <span class="badge">${esc(CAT_NAME[e.category] || '其他')}</span>
            ${stars(e.rating)}
          </p>
          <section class="panel">
            <dl class="kv">
              ${row('试穿日期', esc(e.triedAt))}
              ${row('门店', esc(e.store))}
              ${row('颜色', esc(e.color))}
              ${row('尺码', esc(e.size))}
              ${row('尺码感受', FIT[e.fit] || '')}
              ${row('长度', LENGTH[e.length] || '')}
              ${row('标签', esc((e.tags || []).join('、')))}
            </dl>
          </section>
          ${e.pros ? `<section class="panel"><h2>喜欢的地方</h2><p class="note">${esc(e.pros)}</p></section>` : ''}
          ${e.notes ? `<section class="panel"><h2>不满意 / 备注</h2><p class="note">${esc(e.notes)}</p></section>` : ''}
          <section class="panel">
            <h2>商品信息</h2>
            <dl class="kv">
              ${row('编号', esc(p.productId))}
              ${row('官网分类', esc((p.category || []).join(' › ')))}
              ${row('价格', esc(price(p.price)))}
              ${row('材质', esc(p.composition))}
              ${row('官网', p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">打开商品页 ↗</a>` : '')}
            </dl>
          </section>
          ${
            related.length
              ? `<section class="panel"><h2>同款其他试穿</h2><div class="related">${related
                  .map((r) => `<a href="#/entry/${esc(r.id)}"><span>${esc(r.triedAt || '')} · ${esc(r.size || '')} ${esc(r.color || '')}</span><span>${FIT[r.fit] || ''}</span></a>`)
                  .join('')}</div></section>`
              : ''
          }
          <div class="actions">
            <button class="btn danger" id="del">删除</button>
            <a class="btn" href="#/new/${encodeURIComponent(p.productId || '')}">再记一次</a>
            <a class="btn primary" href="#/edit/${esc(e.id)}">编辑</a>
          </div>
        </div>
      </div>
    </article>`;

  app.querySelector('#del').addEventListener('click', async () => {
    if (!confirm('确定删除这条试穿记录吗？')) return;
    try {
      await api(`/entries/${encodeURIComponent(e.id)}`, { method: 'DELETE' });
      state.entries = state.entries.filter((x) => x.id !== e.id);
      safeSet(CACHE_KEY, JSON.stringify(state.entries));
      toast('已删除');
      location.hash = '#/';
    } catch (err) {
      toast(`删除失败：${err.message}`);
    }
  });
}

// ---------- 设置 ----------

async function renderSettings() {
  const entries = await loadEntries().catch(() => state.entries || []);
  let info = null;
  let archive = null;
  try { [info, archive] = await Promise.all([api('/ping'), api('/archive')]); } catch {}
  const count = (k) => entries.filter((e) => e.verdict === k).length;

  app.innerHTML = `
    <a class="back" href="#/">‹ 返回</a>
    <section class="panel">
      <h2>概览</h2>
      <div class="stats">
        <div class="stat"><b>${entries.length}</b><span>试穿记录</span></div>
        <div class="stat"><b>${new Set(entries.map((e) => e.product?.productId)).size}</b><span>不同款式</span></div>
        <div class="stat"><b>${count('bought')}</b><span>已购买</span></div>
        <div class="stat"><b>${count('want')}</b><span>想买</span></div>
      </div>
      ${info ? `<p class="hint">优衣库站点：${esc(info.region)} / ${esc(info.lang)}（在 wrangler.jsonc 的 vars 里修改）</p>` : ''}
    </section>
    <section class="panel">
      <h2>官网图片存档</h2>
      ${
        !archive
          ? '<p class="hint" style="margin:0">无法读取存档状态</p>'
          : !archive.enabled
            ? '<p class="hint" style="margin:0">未启用：服务器没有绑定 R2（见 README「官网图片存档」）。现在显示的是官网实时图片，商品下架后可能失效。</p>'
            : `<p style="margin:0 0 10px">已存档 <b>${archive.archived}</b> / ${archive.total} 张商品图</p>
               <p class="hint" style="margin:0 0 12px">保存记录时会自动把官网图复制一份到你自己的存储里，官网删图后照样能看。</p>
               ${archive.archived < archive.total ? '<div class="actions" style="justify-content:flex-start"><button class="btn" id="backfill">补存剩下的图片</button></div>' : ''}`
      }
    </section>
    <section class="panel">
      <h2>备份</h2>
      <p class="hint" style="margin:0 0 12px">导出为 JSON 文件；导入会把文件里的记录作为新记录追加。</p>
      <div class="actions" style="justify-content:flex-start">
        <button class="btn" id="export">导出 JSON</button>
        <label class="btn">导入 JSON<input type="file" id="import" accept="application/json,.json" hidden></label>
      </div>
    </section>
    <section class="panel">
      <h2>设备</h2>
      <div class="actions" style="justify-content:flex-start">
        <button class="btn" id="refresh">重新同步</button>
        <button class="btn danger" id="logout">退出登录</button>
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
      toast(`已导入 ${ok} 条`);
      renderSettings();
    } catch (e) {
      toast(`导入失败：${e.message}`);
    }
  });

  app.querySelector('#backfill')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    let total = 0;
    try {
      // 每次请求最多处理 30 张，循环到没有进展为止
      for (;;) {
        btn.textContent = `存档中…已完成 ${total} 张`;
        const r = await api('/archive', { method: 'POST' });
        total += r.archived;
        if (!r.remaining || !r.archived) break;
      }
      await loadEntries(true);
      toast(`新存档 ${total} 张`);
    } catch (e) {
      toast(`存档失败：${e.message}`);
    }
    renderSettings();
  });

  app.querySelector('#refresh').addEventListener('click', async () => {
    await loadEntries(true);
    toast('已同步');
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

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
router();
