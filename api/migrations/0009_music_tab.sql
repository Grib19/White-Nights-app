-- Песни вынесены во вкладку «Музыку» (таблица songs), из «Информации» раздел убираем
DELETE FROM info_docs WHERE slug = 'songs';
