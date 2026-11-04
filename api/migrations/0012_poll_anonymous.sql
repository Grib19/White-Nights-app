-- Анонимный опрос: имена проголосовавших никому не показываются
ALTER TABLE polls ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 0;
