import { fetchUpstream, lookupProduct, parseProductInput } from './uniqlo.js';

const PRODUCT_CACHE_SECONDS = 60 * 60 * 24;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      const authError = checkAuth(request, env);
      if (authError) return authError;
      return await route(request, env, ctx, url);
    } catch (e) {
      console.error(e);
      return json({ error: 'internal_error', message: String(e?.message || e) }, 500);
    }
  },
};

async function route(request, env, ctx, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // 去掉 "api"
  const method = request.method;
  const opts = { region: env.UQ_REGION || 'se', lang: env.UQ_LANG || 'en' };

  if (parts[0] === 'ping' && method === 'GET') return json({ ok: true, ...opts });

  if (parts[0] === 'product' && parts[1] && method === 'GET') {
    const input = decodeURIComponent(parts[1]);
    if (!parseProductInput(input)) return json({ error: 'bad_id', message: '没有识别出 6 位商品编号' }, 400);
    if (parts[2] === 'raw') return json(await fetchUpstream(input, opts));
    return productLookup(input, opts, ctx);
  }

  if (parts[0] === 'entries') {
    const id = parts[1] ? decodeURIComponent(parts[1]) : null;
    if (!id && method === 'GET') return listEntries(env);
    if (!id && method === 'POST') return createEntry(request, env);
    if (id && method === 'GET') return getEntry(env, id);
    if (id && method === 'PUT') return updateEntry(request, env, id);
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

async function productLookup(input, opts, ctx) {
  const parsed = parseProductInput(input);
  const cacheKey = new Request(
    `https://cache.internal/product/${opts.region}/${opts.lang}/${parsed.productId}/${parsed.priceGroup || ''}`,
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
      { error: 'not_found', message: `在优衣库 ${opts.region} 站点没有找到 ${parsed.productId}`, productId: parsed.productId },
      404,
    );
  }
  const res = json({ product }, 200, { 'Cache-Control': `max-age=${PRODUCT_CACHE_SECONDS}` });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
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

async function createEntry(request, env) {
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
    return getEntry(env, id).then((r) => new Response(r.body, { status: 201, headers: r.headers }));
  });
}

async function updateEntry(request, env, id) {
  return withHttpErrors(async () => {
    const { productId, text } = sanitize(await readBody(request));
    const r = await env.DB.prepare('UPDATE entries SET product_id = ?, data = ?, updated_at = ? WHERE id = ?')
      .bind(productId, text, Date.now(), id)
      .run();
    if (!r.meta.changes) return json({ error: 'not_found' }, 404);
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
