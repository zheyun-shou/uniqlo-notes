// 降价提醒：定时查关注商品的官网售价，降价时发邮件（通过 Resend）。
// Workers 免费套餐每次最多 10ms CPU、50 个外部请求，所以每次只查几件（每件查 2 个页面），按“最久没查”轮流来。

import { fetchPrices } from './uniqlo.js';

export const WATCH_BATCH = 4;
const RESEND_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'UNIQLO FITLOG <onboarding@resend.dev>';

/**
 * 根据当前价格决定要不要提醒，并给出新的比较基准。
 * - 比基准便宜（且达到目标价，如果设了的话）→ 提醒，基准更新为当前价
 * - 比基准贵（涨回去了）→ 不提醒，基准更新为当前价，下次再降还会提醒
 */
export function decide({ ref_price: ref, target_price: target }, cur) {
  if (cur == null) return { notify: false, ref };
  if (ref == null) return { notify: target != null && cur <= target, ref: cur };
  if (cur < ref && (target == null || cur <= target)) return { notify: true, ref: cur };
  if (cur > ref) return { notify: false, ref: cur };
  return { notify: false, ref };
}

// ---------- 设置 ----------

export async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row?.value ?? null;
}

export async function setSetting(env, key, value) {
  if (value == null || value === '') await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
  else await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}

export async function emailStatus(env) {
  return { to: await getSetting(env, 'alert_email'), keyConfigured: Boolean(env.RESEND_API_KEY) };
}

// ---------- 关注列表 ----------

function rowToWatch(r) {
  return {
    productId: r.product_id,
    name: r.name,
    image: r.image,
    url: r.url,
    targetPrice: r.target_price,
    currency: r.currency,
    basePrice: r.base_price,
    lastPrice: r.last_price,
    lowestPrice: r.lowest_price,
    saleColors: r.sale_colors ? JSON.parse(r.sale_colors) : [],
    lastChecked: r.last_checked,
    lastNotified: r.last_notified,
    createdAt: r.created_at,
  };
}

export async function listWatches(env) {
  const { results } = await env.DB.prepare('SELECT * FROM watches ORDER BY created_at DESC').all();
  return results.map(rowToWatch);
}

export async function getWatch(env, productId) {
  const row = await env.DB.prepare('SELECT * FROM watches WHERE product_id = ?').bind(productId).first();
  return row ? rowToWatch(row) : null;
}

/** 新建或更新关注。新建时用前端带来的当前价作为比较基准。 */
export async function upsertWatch(env, productId, b) {
  const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const target = num(b.targetPrice);
  const existing = await env.DB.prepare('SELECT product_id FROM watches WHERE product_id = ?').bind(productId).first();
  if (existing) {
    await env.DB.prepare('UPDATE watches SET target_price = ? WHERE product_id = ?').bind(target, productId).run();
  } else {
    const price = num(b.price);
    await env.DB.prepare(
      `INSERT INTO watches (product_id, name, image, url, target_price, currency, base_price, last_price, lowest_price, ref_price, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(productId, str(b.name), str(b.image), str(b.url), target, str(b.currency), num(b.basePrice), price, price, price, Date.now())
      .run();
  }
  return getWatch(env, productId);
}

export async function removeWatch(env, productId) {
  const r = await env.DB.prepare('DELETE FROM watches WHERE product_id = ?').bind(productId).run();
  return r.meta.changes > 0;
}

function str(v) {
  return v == null ? null : String(v).slice(0, 1000);
}

// ---------- 定时检查 ----------

/**
 * 查最久没查的几件（或指定的几件），记录价格，降价的合并成一封邮件发出。
 * 邮件发送失败时不更新比较基准，下次检查会再提醒。
 */
export async function checkWatches(env, opts, { limit = WATCH_BATCH, ids = null } = {}) {
  const rows = ids?.length
    ? (await env.DB.prepare(`SELECT * FROM watches WHERE product_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results
    : (await env.DB.prepare('SELECT * FROM watches ORDER BY last_checked IS NOT NULL, last_checked LIMIT ?').bind(limit).all()).results;

  const now = Date.now();
  const updates = [];
  const drops = [];
  const checked = [];
  for (const w of rows.slice(0, limit)) {
    const r = await fetchPrices(w.product_id, opts);
    if (!r.found) {
      checked.push({ productId: w.product_id, found: false, upstreamDown: r.upstreamDown });
      // 官网暂时连不上就不记为已检查，下次优先再查
      if (!r.upstreamDown) updates.push({ w, set: { last_checked: now } });
      continue;
    }
    const d = decide(w, r.min);
    const set = {
      name: r.name || w.name,
      image: w.image || r.image,
      url: r.url,
      currency: r.currency,
      base_price: r.base,
      last_price: r.min,
      lowest_price: w.lowest_price == null ? r.min : Math.min(w.lowest_price, r.min),
      sale_colors: JSON.stringify(r.saleColors),
      last_checked: now,
    };
    checked.push({ productId: w.product_id, found: true, price: r.min, base: r.base, notify: d.notify });
    if (d.notify) drops.push({ w, r, d, set });
    else updates.push({ w, set: { ...set, ref_price: d.ref } });
  }

  let email = null;
  if (drops.length) {
    email = await sendDropEmail(env, drops);
    for (const x of drops) {
      updates.push({ w: x.w, set: email.ok ? { ...x.set, ref_price: x.d.ref, last_notified: now } : x.set });
    }
  }

  for (const { w, set } of updates) {
    const keys = Object.keys(set);
    await env.DB.prepare(`UPDATE watches SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE product_id = ?`)
      .bind(...keys.map((k) => set[k]), w.product_id)
      .run();
  }
  return { checked, notified: drops.length, email };
}

// ---------- 邮件 ----------

export async function sendEmail(env, { subject, html }) {
  const to = await getSetting(env, 'alert_email');
  if (!to) return { ok: false, error: '还没有填写提醒邮箱' };
  if (!env.RESEND_API_KEY) return { ok: false, error: '服务器还没有设置 RESEND_API_KEY' };
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.ALERT_FROM || DEFAULT_FROM, to: [to], subject, html }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, status: res.status, error: body.message || body.name || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function money(value, currency) {
  if (value == null) return '';
  try {
    return new Intl.NumberFormat('sv-SE', { style: 'currency', currency: currency || 'SEK', maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${value} ${currency || ''}`;
  }
}

function h(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function dropEmail(drops, appUrl) {
  const items = drops.map(({ w, r }) => {
    const off = r.base > r.min ? Math.round((1 - r.min / r.base) * 100) : 0;
    return `
      <tr><td style="padding:12px 0;border-top:1px solid #dadada;vertical-align:top;width:96px">
        ${r.image || w.image ? `<img src="${h(w.image || r.image)}" width="84" style="display:block;width:84px" alt="">` : ''}
      </td><td style="padding:12px 0 12px 12px;border-top:1px solid #dadada;vertical-align:top">
        <div style="font-size:15px;font-weight:700;color:#1b1b1b">${h(r.name || w.name)}</div>
        <div style="margin:4px 0;font-size:18px;font-weight:700;color:#ff0000">${h(money(r.min, r.currency))}
          ${r.base > r.min ? `<span style="font-size:13px;font-weight:400;color:#7d7d7d;text-decoration:line-through">${h(money(r.base, r.currency))}</span> <span style="font-size:13px">-${off}%</span>` : ''}</div>
        ${w.target_price != null ? `<div style="font-size:12px;color:#7d7d7d">你的目标价 ${h(money(w.target_price, r.currency))}</div>` : ''}
        ${r.saleColors.length ? `<div style="font-size:12px;color:#7d7d7d">降价颜色：${h(r.saleColors.join('、'))}</div>` : ''}
        <div style="margin-top:6px;font-size:13px"><a href="${h(r.url)}" style="color:#1b1b1b">打开官网商品页 ›</a></div>
      </td></tr>`;
  });
  const subject = drops.length === 1 ? `降价提醒：${drops[0].r.name || drops[0].w.name} 现在 ${money(drops[0].r.min, drops[0].r.currency)}` : `降价提醒：${drops.length} 件关注的商品降价了`;
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;color:#1b1b1b">
    <div style="font-size:20px;font-weight:700;padding:8px 0 12px">UNIQLO FITLOG</div>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${items.join('')}</table>
    ${appUrl ? `<p style="font-size:12px;color:#7d7d7d;border-top:1px solid #dadada;padding-top:12px"><a href="${h(appUrl)}/#/watch" style="color:#7d7d7d">管理降价提醒</a></p>` : ''}
  </div>`;
  return { subject, html };
}

async function sendDropEmail(env, drops) {
  return sendEmail(env, dropEmail(drops, env.APP_URL));
}
