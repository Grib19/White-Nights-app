-- Несколько напоминаний на одну задачу
CREATE TABLE IF NOT EXISTS task_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  remind_at TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_task_reminders_due ON task_reminders (sent, remind_at);
CREATE INDEX IF NOT EXISTS idx_task_reminders_task ON task_reminders (task_id);
INSERT INTO task_reminders (task_id, remind_at, sent)
  SELECT id, remind_at, reminder_sent FROM tasks WHERE remind_at IS NOT NULL;

-- Подпункты внутри задачи
CREATE TABLE IF NOT EXISTS task_subtasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_task_subtasks_task ON task_subtasks (task_id, position);
