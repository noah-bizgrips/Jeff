-- Rebrand: the assistant is now called Gomez. Stored actor values and
-- user-visible text that named it are updated; table and column names are
-- unchanged (the product name is not part of the schema).

alter table public.obligations alter column origin set default 'gomez';

update public.operating_rules set created_by = 'gomez' where created_by = 'jeff';
update public.obligations set origin = 'gomez' where origin = 'jeff';

update public.operating_rules set description = replace(replace(description, 'Jeff''s', 'Gomez''s'), 'Jeff', 'Gomez') where description like '%Jeff%';
update public.alerts set title = replace(replace(title, 'Jeff''s', 'Gomez''s'), 'Jeff', 'Gomez'), summary = replace(replace(summary, 'Jeff''s', 'Gomez''s'), 'Jeff', 'Gomez') where title like '%Jeff%' or summary like '%Jeff%';
update public.findings set title = replace(replace(title, 'Jeff''s', 'Gomez''s'), 'Jeff', 'Gomez'), interpretation = replace(replace(interpretation, 'Jeff''s', 'Gomez''s'), 'Jeff', 'Gomez'), limitations = replace(replace(limitations, 'Jeff''s', 'Gomez''s'), 'Jeff', 'Gomez') where title like '%Jeff%' or interpretation like '%Jeff%' or limitations like '%Jeff%';
update public.missions set title = replace(replace(title, 'Jeff''s', 'Gomez''s'), 'Jeff', 'Gomez'), goal = replace(replace(goal, 'Jeff''s', 'Gomez''s'), 'Jeff', 'Gomez') where title like '%Jeff%' or goal like '%Jeff%';
update public.obligations set title = replace(replace(title, 'Jeff''s', 'Gomez''s'), 'Jeff', 'Gomez'), description = replace(replace(description, 'Jeff''s', 'Gomez''s'), 'Jeff', 'Gomez') where title like '%Jeff%' or description like '%Jeff%';
