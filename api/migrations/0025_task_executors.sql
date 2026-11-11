-- Исполнители выбираются из видящих задачу; подтверждение выполнения
ALTER TABLE task_access ADD COLUMN is_executor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN needs_confirm INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN confirm_condition TEXT;
