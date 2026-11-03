-- Порядок разделов в «Информации»: «Песни» — всегда последние
ALTER TABLE info_docs ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE info_docs SET sort_order = 1 WHERE slug = 'songs';
