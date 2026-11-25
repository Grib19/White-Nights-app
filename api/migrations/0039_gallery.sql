-- Галерея: альбомы и фотографии. Сами файлы лежат на Google Диске,
-- в базе хранятся только ссылки и подписи.
CREATE TABLE IF NOT EXISTS gdrive_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  connected_by INTEGER NOT NULL REFERENCES users(id),
  connected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover_photo_id INTEGER,
  -- managers: фото добавляет комсостав и пресрук, all: любой участник
  upload_scope TEXT NOT NULL DEFAULT 'managers' CHECK (upload_scope IN ('managers', 'all')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS album_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  drive_file_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  added_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS album_photos_album ON album_photos(album_id);
