-- Расшифровка голосовых сообщений (Workers AI, Whisper): NULL — ещё не расшифровано, '' — не удалось
ALTER TABLE messages ADD COLUMN transcript TEXT;
