-- Undo the Gomez rebrand (20260924000000): the assistant is called Jeff again.
alter table public.obligations alter column origin set default 'jeff';
update public.operating_rules set created_by = 'jeff' where created_by = 'gomez';
update public.obligations set origin = 'jeff' where origin = 'gomez';
update public.operating_rules set description = replace(replace(description, 'Gomez''s', 'Jeff''s'), 'Gomez', 'Jeff') where description like '%Gomez%';
update public.alerts set title = replace(replace(title, 'Gomez''s', 'Jeff''s'), 'Gomez', 'Jeff'), summary = replace(replace(summary, 'Gomez''s', 'Jeff''s'), 'Gomez', 'Jeff') where title like '%Gomez%' or summary like '%Gomez%';
update public.findings set title = replace(replace(title, 'Gomez''s', 'Jeff''s'), 'Gomez', 'Jeff'), interpretation = replace(replace(interpretation, 'Gomez''s', 'Jeff''s'), 'Gomez', 'Jeff'), limitations = replace(replace(limitations, 'Gomez''s', 'Jeff''s'), 'Gomez', 'Jeff') where title like '%Gomez%' or interpretation like '%Gomez%' or limitations like '%Gomez%';
update public.missions set title = replace(replace(title, 'Gomez''s', 'Jeff''s'), 'Gomez', 'Jeff'), goal = replace(replace(goal, 'Gomez''s', 'Jeff''s'), 'Gomez', 'Jeff') where title like '%Gomez%' or goal like '%Gomez%';
update public.obligations set title = replace(replace(title, 'Gomez''s', 'Jeff''s'), 'Gomez', 'Jeff'), description = replace(replace(description, 'Gomez''s', 'Jeff''s'), 'Gomez', 'Jeff') where title like '%Gomez%' or description like '%Gomez%';
