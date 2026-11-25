-- Холсты: личный (рисует только автор) или общий (рисуют все участники чата)
CREATE TABLE IF NOT EXISTS canvases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'shared',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Штрихи холста: JSON {color, width, points: [[x, y], ...]} с координатами от 0 до 1
CREATE TABLE IF NOT EXISTS canvas_strokes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canvas_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS canvas_strokes_canvas ON canvas_strokes (canvas_id, id);
ALTER TABLE messages ADD COLUMN canvas_id INTEGER;
