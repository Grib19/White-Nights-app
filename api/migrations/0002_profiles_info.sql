-- Профиль участника: то, что видят все подтверждённые участники
CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username TEXT UNIQUE COLLATE NOCASE,
  position TEXT NOT NULL DEFAULT '',
  study_place TEXT NOT NULL DEFAULT '',
  course TEXT NOT NULL DEFAULT '',
  specialty TEXT NOT NULL DEFAULT '',
  birth_date TEXT NOT NULL DEFAULT '',
  sizes TEXT NOT NULL DEFAULT '',
  achievements TEXT NOT NULL DEFAULT '',
  photo_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Закрытые данные: видят только сам участник и комсостав
CREATE TABLE IF NOT EXISTS private_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  passport TEXT NOT NULL DEFAULT '',
  inn TEXT NOT NULL DEFAULT '',
  snils TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  parent_name TEXT NOT NULL DEFAULT '',
  parent_phone TEXT NOT NULL DEFAULT '',
  extra TEXT NOT NULL DEFAULT ''
);

-- Общая информация: правила, символика, песни. Редактирует комсостав.
CREATE TABLE IF NOT EXISTS info_docs (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by INTEGER REFERENCES users(id)
);

INSERT OR IGNORE INTO info_docs (slug, title) VALUES
  ('rules-rso', 'Правила РСО'),
  ('rules-shtab', 'Правила штаба'),
  ('rules-otryad', 'Правила отряда'),
  ('symbols', 'Атрибутика и символика'),
  ('songs', 'Песни');
