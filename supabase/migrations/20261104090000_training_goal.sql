-- Tenth: weekly training goal on Progress (weeks run Monday to Sunday).
-- Michael aims for 5 training days a week (6 is a bonus); knee physio counts as training.

alter table public.profile
  add column if not exists training_days_goal smallint not null default 5
    check (training_days_goal between 1 and 7);
