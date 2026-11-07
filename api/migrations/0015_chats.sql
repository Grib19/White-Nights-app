-- Чаты: общий, комсостава, личные и групповые. Сообщения доставляются через Ably.
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- general | committee | personal | group
  title TEXT,
  personal_key TEXT UNIQUE,        -- для личных чатов: "меньший_id:больший_id"
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  attachment_id TEXT,
  attachment_name TEXT,
  attachment_kind TEXT,            -- image | file
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at TEXT,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, id);

INSERT INTO chats (kind, title) VALUES ('general', 'Общий чат');
INSERT INTO chats (kind, title) VALUES ('committee', 'Чат комсостава');
