-- 邮箱登录：一次性登录码（邮件里的链接和 6 位数字码对应同一行）
CREATE TABLE IF NOT EXISTS login_codes (
  id TEXT PRIMARY KEY,          -- 链接里那串随机值的 SHA-256
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,      -- 6 位数字码加 id 后的 SHA-256
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes (email, created_at);

-- 登录后的会话：只存会话令牌的 SHA-256，令牌本身只在浏览器里
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
