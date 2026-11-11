-- Задачи: назначает комсостав или участник создаёт себе
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  importance INTEGER NOT NULL DEFAULT 3,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  assignee_id INTEGER NOT NULL REFERENCES users(id),
  assigned_by_committee INTEGER NOT NULL DEFAULT 0,
  attachment_id TEXT,
  attachment_name TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  done_at TEXT,
  remind_at TEXT,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks (assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks (creator_id);
CREATE INDEX IF NOT EXISTS idx_tasks_remind ON tasks (reminder_sent, remind_at);

-- Простые комментарии к задаче
CREATE TABLE IF NOT EXISTS task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments (task_id, id);
