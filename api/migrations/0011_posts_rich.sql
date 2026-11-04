-- Посты: положение текста, любой прикреплённый файл, опросы
ALTER TABLE posts ADD COLUMN text_position TEXT NOT NULL DEFAULT 'top';
ALTER TABLE posts ADD COLUMN attachment_id TEXT;
ALTER TABLE posts ADD COLUMN attachment_name TEXT;

CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  multiple INTEGER NOT NULL DEFAULT 0,
  lock_vote INTEGER NOT NULL DEFAULT 0,
  ends_at TEXT
);

CREATE TABLE IF NOT EXISTS poll_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (poll_id, option_id, user_id)
);
