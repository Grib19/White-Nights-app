-- Важность и исполнитель у подпунктов
ALTER TABLE task_subtasks ADD COLUMN importance INTEGER NOT NULL DEFAULT 3;
ALTER TABLE task_subtasks ADD COLUMN assignee_id INTEGER REFERENCES users(id);
