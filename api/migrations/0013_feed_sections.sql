-- Лента: разделы «Важное» и «Посты»; право писать в «Важное» для участников, которым его дал комсостав
ALTER TABLE posts ADD COLUMN section TEXT NOT NULL DEFAULT 'posts';
ALTER TABLE users ADD COLUMN can_post_important INTEGER NOT NULL DEFAULT 0;
