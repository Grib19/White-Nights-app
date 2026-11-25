-- Доски в стиле Trello: у каждого участника своя доска, свои колонки, карточки — задачи.
-- Одна задача может быть на нескольких досках (PRIMARY KEY board_id + task_id).
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_boards_creator ON boards (creator_id);

-- Кому доска видна; can_edit = 1 — может менять колонки и карточки
CREATE TABLE IF NOT EXISTS board_members (
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  can_edit INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (board_id, user_id)
);

CREATE TABLE IF NOT EXISTS board_columns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_board_columns_board ON board_columns (board_id, position);

CREATE TABLE IF NOT EXISTS board_cards (
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  column_id INTEGER NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (board_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_board_cards_column ON board_cards (column_id, position);
