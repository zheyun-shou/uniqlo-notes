// 邮箱登录：只有 OWNER_EMAIL 里的邮箱能登录。输入邮箱 → 收到一封带链接和 6 位数字码的邮件 → 换成会话令牌。
// 令牌、链接里的随机值、数字码在数据库里都只存 SHA-256。APP_TOKEN 设置了就仍然可以用口令登录（过渡用）。

import { sendEmail } from './watch.js';

const CODE_TTL = 15 * 60 * 1000;
const SESSION_TTL = 365 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_WINDOW = 5;

export function ownerEmails(env) {
  return String(env.OWNER_EMAIL || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function authConfig(env) {
  return { emailLogin: ownerEmails(env).length > 0 && Boolean(env.RESEND_API_KEY), tokenLogin: Boolean(env.APP_TOKEN) };
}

/** 请求头里的令牌有效就返回 { via, email }，否则 null */
export async function checkSession(env, bearer) {
  if (!bearer) return null;
  if (env.APP_TOKEN && timingSafeEqual(bearer, env.APP_TOKEN)) return { via: 'token' };
  const row = await env.DB.prepare('SELECT email FROM sessions WHERE id = ? AND expires_at > ?').bind(await sha256(bearer), Date.now()).first();
  // 从 OWNER_EMAIL 里删掉的邮箱，旧会话也一起失效
  if (!row || !ownerEmails(env).includes(row.email)) return null;
  return { via: 'email', email: row.email };
}

/** 发登录邮件。返回 { status, body } */
export async function requestLogin(env, rawEmail, origin) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, body: { error: 'bad_email', message: 'Enter a valid email address' } };
  if (!authConfig(env).emailLogin) {
    return { status: 503, body: { error: 'not_configured', message: 'Email sign-in isn’t set up on this server yet (OWNER_EMAIL and RESEND_API_KEY).' } };
  }
  if (!ownerEmails(env).includes(email)) {
    return {
      status: 403,
      body: { error: 'not_owner', message: 'This copy of FITLOG is private, so only its owner can sign in. Try it without an account, or deploy your own copy.' },
    };
  }

  const now = Date.now();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_codes WHERE email = ? AND created_at > ?').bind(email, now - CODE_TTL).first();
  if (recent.n >= MAX_CODES_PER_WINDOW) {
    return { status: 429, body: { error: 'rate_limited', message: 'Too many sign-in emails. Use the latest one, or try again in 15 minutes.' } };
  }

  const token = randomToken();
  const code = randomCode();
  const id = await sha256(token);
  await env.DB.prepare('INSERT INTO login_codes (id, email, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, email, await sha256(`${code}:${id}`), now, now + CODE_TTL)
    .run();

  const sent = await sendEmail(env, { to: email, ...loginEmail(code, `${origin}/#/auth/${token}`) });
  if (!sent.ok) {
    await env.DB.prepare('DELETE FROM login_codes WHERE id = ?').bind(id).run();
    return { status: 502, body: { error: 'email_failed', message: `Couldn’t send the email: ${sent.error}` } };
  }
  return { status: 200, body: { ok: true } };
}

/** 用邮件里的链接（token）或邮箱 + 数字码换会话令牌。返回 { status, body } */
export async function verifyLogin(env, { token, email, code }) {
  const now = Date.now();
  const fail = { status: 400, body: { error: 'bad_code', message: 'That code or link is invalid or has expired. Request a new one.' } };
  let row;
  if (token) {
    row = await env.DB.prepare('SELECT * FROM login_codes WHERE id = ? AND used_at IS NULL AND expires_at > ?').bind(await sha256(String(token)), now).first();
  } else {
    const e = String(email || '').trim().toLowerCase();
    const c = String(code || '').replace(/\D/g, '');
    if (!e || c.length !== 6) return fail;
    row = await env.DB.prepare('SELECT * FROM login_codes WHERE email = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1').bind(e, now).first();
    if (!row || row.attempts >= MAX_ATTEMPTS) return fail;
    if ((await sha256(`${c}:${row.id}`)) !== row.code_hash) {
      await env.DB.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();
      return fail;
    }
  }
  if (!row || !ownerEmails(env).includes(row.email)) return fail;

  const used = await env.DB.prepare('UPDATE login_codes SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(now, row.id).run();
  if (!used.meta.changes) return fail;

  const session = randomToken();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (id, email, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(session), row.email, now, now + SESSION_TTL),
    // 顺手清掉过期的登录码和会话
    env.DB.prepare('DELETE FROM login_codes WHERE expires_at < ?').bind(now - CODE_TTL),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
  ]);
  return { status: 200, body: { session, email: row.email } };
}

export async function logout(env, bearer) {
  if (bearer) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256(bearer)).run();
}

export function loginEmail(code, link) {
  return {
    subject: `Your UNIQLO FITLOG sign-in code: ${code}`,
    html: `<div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;color:#6a0c06">
      <div style="font-size:20px;font-weight:700;letter-spacing:-0.04em;padding:8px 0 16px">UNIQLO FITLOG</div>
      <p style="margin:0 0 8px;font-size:14px">Your sign-in code:</p>
      <div style="font-size:36px;font-weight:700;letter-spacing:0.2em;margin:0 0 20px">${code}</div>
      <p style="margin:0 0 20px"><a href="${link}" style="display:inline-block;background:#6a0c06;color:#ffffff;padding:12px 22px;text-decoration:none;font-size:13px;letter-spacing:0.12em">SIGN IN</a></p>
      <p style="font-size:12px;color:#8a4a44;margin:0">Type the code into the app, or tap the button on the device you want to sign in on. Both expire in 15 minutes. If you didn’t ask to sign in, ignore this email.</p>
    </div>`,
  };
}

// ---------- 工具 ----------

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomCode() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
}

export function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
