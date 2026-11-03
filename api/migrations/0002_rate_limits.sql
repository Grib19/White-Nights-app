-- Счётчики попыток входа и регистрации. Нужны, чтобы нельзя было подобрать пароль перебором.
-- limit_key: 'login:email:<почта>', 'login:ip:<адрес>' или 'register:ip:<адрес>'.
CREATE TABLE IF NOT EXISTS rate_limits (
  limit_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL,
  blocked_until TEXT
);

CREATE INDEX IF NOT EXISTS rate_limits_window ON rate_limits(window_start);
