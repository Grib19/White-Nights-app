-- Ответы, пересылка и закреплённое сообщение
ALTER TABLE messages ADD COLUMN reply_to_id INTEGER;
ALTER TABLE messages ADD COLUMN forwarded_from TEXT;
ALTER TABLE chats ADD COLUMN pinned_message_id INTEGER;
