-- Настройки группы: описание и кто может приглашать и менять информацию
ALTER TABLE chats ADD COLUMN description TEXT;
ALTER TABLE chats ADD COLUMN invite_mode TEXT NOT NULL DEFAULT 'all';   -- all | creator
ALTER TABLE chats ADD COLUMN edit_mode TEXT NOT NULL DEFAULT 'all';     -- all | creator
