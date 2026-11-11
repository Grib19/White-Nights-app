-- Задача всему отряду: видна всем участникам, каждый отмечает выполнение сам
ALTER TABLE tasks ADD COLUMN for_all INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS task_done (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  done_at TEXT NOT NULL,
  PRIMARY KEY (task_id, user_id)
);
