import { fetchSearchPage, fetchUpstream, lookupProduct, parseProductInput, parseSearchResults } from './uniqlo.js';
import { archiveBacklog, archiveEntry, archiveStatus, serveMedia } from './archive.js';
import { serveStatic } from './static.js';
import { checkWatches, emailStatus, getWatch, listWatches, removeWatch, sendEmail, setSetting, upsertWatch } from './watch.js';

const PRODUCT_CACHE_SECONDS = 60 * 60 * 24;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 存档图片公开可读（<img> 无法带口令），内容都是官网公开商品图
    if (url.pathname.startsWith('/media/') && request.method === 'GET') return serveMedia(env, url.pathname.slice(7));
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname);

    try {
      const authError = checkAuth(request, env);
      if (authError) return authError;
      return await route(request, env, ctx, url);
    } catch (e) {
      console.error(e);
      return json({ error: 'internal_error', message: String(e?.message || e) }, 500);
    }
  },

  // 定时任务（wrangler.jsonc 的 triggers.crons）：检查降价
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkWatches(env, optsFrom(env)).then((r) => console.log('watch check', JSON.stringify(r))));
  },
};

function optsFrom(env) {
  return { region: env.UQ_REGION || 'se', lang: env.UQ_LANG || 'en', fallback: parseFallback(env.UQ_FALLBACK) };
}

async function route(request, env, ctx, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // 去掉 "api"
  const method = request.method;
  const opts = optsFrom(env);

  if (parts[0] === 'ping' && method === 'GET') return json({ ok: true, region: opts.region, lang: opts.lang });

  if (parts[0] === 'product' && parts[1] && method === 'GET') {
    const input = decodeURIComponent(parts[1]);
    if (!parseProductInput(input)) return json({ error: 'bad_id', message: '没有识别出 6 位商品编号' }, 400);
    // 调试用：?region=uk&lang=en 可以临时查别的站点
    if (parts[2] === 'raw') {
      const region = url.searchParams.get('region');
      const lang = url.searchParams.get('lang');
      const o = {
        region: /^[a-z]{2}$/.test(region || '') ? region : opts.region,
        lang: /^[a-z]{2}$/.test(lang || '') ? lang : opts.lang,
      };
      return json(await fetchUpstream(input, o));
    }
    return productLookup(input, opts, ctx);
  }

  if (parts[0] === 'search' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    if (!q) return json({ error: 'bad_query', message: '请输入要搜索的名称' }, 400);
    if (parts[1] === 'raw') {
      const page = await fetchSearchPage(q, opts);
      return json({ url: page.url, status: page.status, length: page.html.length, results: parseSearchResults(page.html) });
    }
    return productSearch(q, opts, ctx);
  }

  if (parts[0] === 'watches') {
    const id = parts[1] ? decodeURIComponent(parts[1]) : null;
    if (!id && method === 'GET') return json({ watches: await listWatches(env), email: await emailStatus(env) });
    if (id === 'check' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 4) : null;
      return json(await checkWatches(env, opts, { ids }));
    }
    if (id === 'test-email' && method === 'POST') {
      const r = await sendEmail(env, {
        subject: 'UNIQLO FITLOG 测试邮件',
        html: '<div style="font-family:Helvetica,Arial,sans-serif"><b>UNIQLO FITLOG</b><p>收到这封邮件说明降价提醒的邮件设置没问题。</p></div>',
      });
      return json(r, r.ok ? 200 : 400);
    }
    if (id && !/^[A-Z]\d{6}-\d{3}$/.test(id)) return json({ error: 'bad_id', message: '商品编号格式不对' }, 400);
    if (id && method === 'GET') {
      const w = await getWatch(env, id);
      return w ? json({ watch: w }) : json({ error: 'not_found' }, 404);
    }
    if (id && method === 'PUT') return json({ watch: await upsertWatch(env, id, await request.json().catch(() => ({}))) });
    if (id && method === 'DELETE') return (await removeWatch(env, id)) ? json({ ok: true }) : json({ error: 'not_found' }, 404);
  }

  if (parts[0] === 'settings' && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    if ('alertEmail' in body) {
      const v = String(body.alertEmail || '').trim();
      if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return json({ error: 'bad_email', message: '邮箱格式不对' }, 400);
      await setSetting(env, 'alert_email', v);
    }
    return json({ ok: true, email: await emailStatus(env) });
  }

  if (parts[0] === 'archive') {
    if (method === 'GET') return json(await archiveStatus(env));
    if (method === 'POST') return json(await archiveBacklog(env));
  }

  if (parts[0] === 'entries') {
    const id = parts[1] ? decodeURIComponent(parts[1]) : null;
    if (!id && method === 'GET') return listEntries(env);
    if (!id && method === 'POST') return createEntry(request, env, ctx);
    if (id && method === 'GET') return getEntry(env, id);
    if (id && method === 'PUT') return updateEntry(request, env, ctx, id);
    if (id && method === 'DELETE') return deleteEntry(env, id);
  }

  return json({ error: 'not_found' }, 404);
}

// ---------- 鉴权：单用户口令 ----------

function checkAuth(request, env) {
  if (!env.APP_TOKEN) {
    return json({ error: 'not_configured', message: '服务器还没设置 APP_TOKEN，请运行 wrangler secret put APP_TOKEN' }, 500);
  }
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!timingSafeEqual(token, env.APP_TOKEN)) return json({ error: 'unauthorized', message: '口令不正确' }, 401);
  return null;
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

// ---------- 商品查询（带边缘缓存） ----------

// "uk/en,us/en" → [{ region: 'uk', lang: 'en' }, ...]
function parseFallback(s) {
  return String(s || '')
    .split(',')
    .map((x) => x.trim().match(/^([a-z]{2})\/([a-z]{2})$/))
    .filter(Boolean)
    .map((m) => ({ region: m[1], lang: m[2] }));
}

async function productLookup(input, opts, ctx) {
  const parsed = parseProductInput(input);
  const cacheKey = new Request(
    `https://cache.internal/v4/product/${opts.region}/${opts.lang}/${parsed.productId}/${parsed.priceGroup || ''}`,
  );
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const { product, upstreamDown, statuses } = await lookupProduct(input, opts);
  if (!product && upstreamDown) {
    return json(
      { error: 'upstream_error', message: `暂时连不上优衣库官网（${statuses.join(', ')}），可以稍后再试或手动填写`, productId: parsed.productId },
      502,
    );
  }
  if (!product) {
    return json(
      {
        error: 'not_found',
        message: `在优衣库 ${[opts.region, ...opts.fallback.map((o) => o.region)].join(' / ')} 站点都没有找到 ${parsed.productId}`,
        productId: parsed.productId,
      },
      404,
    );
  }
  const res = json({ product }, 200, { 'Cache-Control': `max-age=${PRODUCT_CACHE_SECONDS}` });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// 按名称搜索：先搜本站，没结果再依次搜 fallback 站点；结果缓存 1 小时
async function productSearch(q, opts, ctx) {
  const cacheKey = new Request(`https://cache.internal/v2/search/${opts.region}/${opts.lang}/${encodeURIComponent(q.toLowerCase())}`);
  const hit = await caches.default.match(cacheKey);
  if (hit) return hit;
  let region = opts.region;
  let results = [];
  let reachable = false;
  for (const o of [opts, ...opts.fallback.filter((x) => x.region !== opts.region)]) {
    const page = await fetchSearchPage(q, o);
    if (page.status === 200) reachable = true;
    results = parseSearchResults(page.html);
    if (results.length) {
      region = o.region;
      break;
    }
  }
  if (!reachable) return json({ error: 'upstream_error', message: '暂时连不上优衣库官网，可以稍后再试' }, 502);
  const res = json({ q, region, fallback: region !== opts.region, results }, 200, { 'Cache-Control': 'max-age=3600' });
  ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
}

// ---------- 试穿记录 ----------

function rowToEntry(row) {
  return { id: row.id, ...JSON.parse(row.data), createdAt: row.created_at, updatedAt: row.updated_at };
}

function sanitize(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, '请求内容不是 JSON 对象');
  const { id, createdAt, updatedAt, ...data } = body;
  if (!data.product?.productId) throw new HttpError(400, '缺少 product.productId');
  const text = JSON.stringify(data);
  if (text.length > 200_000) throw new HttpError(413, '记录太大');
  return { productId: String(data.product.productId), text };
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, '请求内容不是合法 JSON');
  }
}

async function listEntries(env) {
  const { results } = await env.DB.prepare('SELECT * FROM entries ORDER BY updated_at DESC').all();
  return json({ entries: results.map(rowToEntry) });
}

async function getEntry(env, id) {
  const row = await env.DB.prepare('SELECT * FROM entries WHERE id = ?').bind(id).first();
  return row ? json({ entry: rowToEntry(row) }) : json({ error: 'not_found' }, 404);
}

async function createEntry(request, env, ctx) {
  return withHttpErrors(async () => {
    const body = await readBody(request);
    const { productId, text } = sanitize(body);
    const id = crypto.randomUUID();
    const now = Date.now();
    // 导入时保留原来的创建时间
    const createdAt = Number.isFinite(body.createdAt) ? body.createdAt : now;
    await env.DB.prepare('INSERT INTO entries (id, product_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, productId, text, createdAt, now)
      .run();
    ctx.waitUntil(archiveEntry(env, id));
    return getEntry(env, id).then((r) => new Response(r.body, { status: 201, headers: r.headers }));
  });
}

async function updateEntry(request, env, ctx, id) {
  return withHttpErrors(async () => {
    const { productId, text } = sanitize(await readBody(request));
    const r = await env.DB.prepare('UPDATE entries SET product_id = ?, data = ?, updated_at = ? WHERE id = ?')
      .bind(productId, text, Date.now(), id)
      .run();
    if (!r.meta.changes) return json({ error: 'not_found' }, 404);
    ctx.waitUntil(archiveEntry(env, id));
    return getEntry(env, id);
  });
}

async function deleteEntry(env, id) {
  const r = await env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(id).run();
  return r.meta.changes ? json({ ok: true }) : json({ error: 'not_found' }, 404);
}

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function withHttpErrors(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) return json({ error: 'bad_request', message: e.message }, e.status);
    throw e;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
