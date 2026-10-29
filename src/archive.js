// 官网图片存档：把记录里引用的商品图复制一份到 R2，商品下架、官网删图后记录里的图依然能看。
// 存档的 key 由原图地址的 SHA-256 决定，同一张图只存一次；前端优先显示存档，失败再回退官网原图。

// 如实标明身份，不伪装成浏览器
const UA = 'uniqlo-notes/0.1 (personal fit log; +https://github.com/zheyun-shou/uniqlo-notes)';
const MAX_BYTES = 8 * 1024 * 1024;

// Workers 免费套餐每次请求最多 50 个外部子请求，一次最多处理这么多张，剩下的下次再存
export const MAX_IMAGES_PER_RUN = 30;

export async function imageKey(url) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return 'img/' + [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 下载并存档一组图片地址，返回 { 原地址: key }（只含成功的） */
export async function archiveUrls(env, urls) {
  const out = {};
  if (!env.IMAGES) return out;
  await Promise.all(
    urls.slice(0, MAX_IMAGES_PER_RUN).map(async (url) => {
      try {
        if (!/^https?:\/\//i.test(url)) return;
        const key = await imageKey(url);
        if (await env.IMAGES.head(key)) {
          out[url] = key;
          return;
        }
        const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/*' } });
        const type = res.headers.get('content-type') || '';
        if (!res.ok || !type.startsWith('image/')) return;
        if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) return;
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_BYTES || !looksLikeImage(new Uint8Array(buf, 0, Math.min(16, buf.byteLength)))) return;
        await env.IMAGES.put(key, buf, { httpMetadata: { contentType: type }, customMetadata: { source: url } });
        out[url] = key;
      } catch (e) {
        console.warn('archive failed', url, String(e));
      }
    }),
  );
  return out;
}

// 有的站点出错时会返回 HTML 却标着 image/*，按文件头再确认一次
export function looksLikeImage(b) {
  const at = (i, ...xs) => xs.every((x, k) => b[i + k] === x);
  return (
    at(0, 0xff, 0xd8, 0xff) || // JPEG
    at(0, 0x89, 0x50, 0x4e, 0x47) || // PNG
    at(0, 0x47, 0x49, 0x46, 0x38) || // GIF
    (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) || // WEBP
    at(4, 0x66, 0x74, 0x79, 0x70) // AVIF/HEIC (ftyp)
  );
}

export function pendingUrls(data) {
  return (data.product?.images || []).filter((i) => i?.url && !i.archived).map((i) => i.url);
}

/**
 * 存档一条记录里还没存档的图片，并把 key 写回记录（product.images[].archived）。
 * 返回 { archived: 本次成功数, remaining: 仍未存档数 }。
 */
export async function archiveEntry(env, id, budget = MAX_IMAGES_PER_RUN) {
  const row = await env.DB.prepare('SELECT data FROM entries WHERE id = ?').bind(id).first();
  if (!row) return { archived: 0, remaining: 0 };
  const todo = pendingUrls(JSON.parse(row.data));
  if (!todo.length || !env.IMAGES) return { archived: 0, remaining: todo.length };

  const done = await archiveUrls(env, todo.slice(0, budget));
  const n = Object.keys(done).length;
  if (n) {
    // 下载期间记录可能被编辑过，重新读一次再合并
    const fresh = await env.DB.prepare('SELECT data FROM entries WHERE id = ?').bind(id).first();
    if (!fresh) return { archived: n, remaining: 0 };
    const data = JSON.parse(fresh.data);
    for (const img of data.product?.images || []) if (done[img.url]) img.archived = done[img.url];
    await env.DB.prepare('UPDATE entries SET data = ? WHERE id = ?').bind(JSON.stringify(data), id).run();
  }
  return { archived: n, remaining: todo.length - n };
}

/** 补存档：按更新时间从新到旧处理，直到用完本次的图片额度 */
export async function archiveBacklog(env) {
  if (!env.IMAGES) return { enabled: false, archived: 0, remaining: 0 };
  const { results } = await env.DB.prepare('SELECT id, data FROM entries ORDER BY updated_at DESC').all();
  let budget = MAX_IMAGES_PER_RUN;
  let archived = 0;
  let remaining = 0;
  for (const row of results) {
    const pending = pendingUrls(JSON.parse(row.data)).length;
    if (!pending) continue;
    if (budget <= 0) {
      remaining += pending;
      continue;
    }
    const r = await archiveEntry(env, row.id, budget);
    budget -= Math.min(pending, budget);
    archived += r.archived;
    remaining += r.remaining;
  }
  return { enabled: true, archived, remaining };
}

/** 存档状态：总图片数 / 已存档数 */
export async function archiveStatus(env) {
  const { results } = await env.DB.prepare('SELECT data FROM entries').all();
  let total = 0;
  let archived = 0;
  for (const row of results) {
    for (const img of JSON.parse(row.data).product?.images || []) {
      if (!img?.url) continue;
      total++;
      if (img.archived) archived++;
    }
  }
  return { enabled: Boolean(env.IMAGES), total, archived };
}

/** GET /media/img/<hash>：公开读取存档图片（内容都是官网公开商品图） */
export async function serveMedia(env, key) {
  if (!env.IMAGES || !/^img\/[0-9a-f]{64}$/.test(key)) return new Response('Not found', { status: 404 });
  const obj = await env.IMAGES.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: obj.httpEtag,
    },
  });
}
