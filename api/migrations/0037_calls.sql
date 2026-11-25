-- Звонки в чатах: один активный звонок на чат, участники до 6 человек
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  video INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS calls_chat_active ON calls (chat_id, ended_at);
CREATE TABLE IF NOT EXISTS call_participants (
  call_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  left_at TEXT,
  PRIMARY KEY (call_id, user_id)
);
