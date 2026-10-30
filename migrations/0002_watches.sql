-- 降价提醒：每个关注的商品一行
CREATE TABLE IF NOT EXISTS watches (
  product_id TEXT PRIMARY KEY,
  name TEXT,
  image TEXT,
  url TEXT,
  target_price REAL,          -- 可选：降到这个价格及以下才提醒
  currency TEXT,
  base_price REAL,            -- 官网原价
  last_price REAL,            -- 最近一次查到的最低售价
  lowest_price REAL,          -- 关注以来见过的最低价
  ref_price REAL,             -- 比较基准：上次提醒时的价格；涨价后重置，方便下次再降时再提醒
  sale_colors TEXT,           -- 最近一次查到的降价颜色（JSON 数组）
  last_checked INTEGER,
  last_notified INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watches_checked ON watches (last_checked);

-- 简单的键值设置（提醒邮箱等）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
