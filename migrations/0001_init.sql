-- 每条试穿记录一行；商品快照和反馈放在 data(JSON) 里，商品下架后记录依然完整
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_product ON entries (product_id);
CREATE INDEX IF NOT EXISTS idx_entries_updated ON entries (updated_at DESC);
