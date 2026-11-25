-- Настройки общего холста: кто может редактировать (all | managers | author) и до какого времени (ISO)
ALTER TABLE canvases ADD COLUMN editors TEXT NOT NULL DEFAULT 'all';
ALTER TABLE canvases ADD COLUMN edit_until TEXT;
