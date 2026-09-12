CREATE TABLE IF NOT EXISTS users (
  chat_id TEXT PRIMARY KEY,
  premium INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_usage (
  chat_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  operations INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, usage_date),
  FOREIGN KEY (chat_id) REFERENCES users(chat_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(usage_date);
