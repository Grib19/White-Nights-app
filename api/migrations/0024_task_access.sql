-- Кому, кроме создателя и исполнителя, видна задача; can_edit = 1 — может редактировать
CREATE TABLE IF NOT EXISTS task_access (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  can_edit INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, user_id)
);
