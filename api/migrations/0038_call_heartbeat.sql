-- Heartbeat участников звонка: участник считается активным, пока присылает ping
ALTER TABLE call_participants ADD COLUMN last_seen TEXT;
UPDATE call_participants SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE left_at IS NULL;
