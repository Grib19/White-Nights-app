-- Кто может отправлять массовые упоминания (@all) в группе: all — все участники, creator — создатель и админы
ALTER TABLE chats ADD COLUMN mention_mode TEXT NOT NULL DEFAULT 'all';
