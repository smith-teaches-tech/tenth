-- Tenth: AI fine-tuned targets.
-- The plan function sets each day's target from the weight-trend math (source 'math').
-- When you accept an AI suggestion, the macros are updated and source becomes 'ai',
-- with the AI's reason kept alongside. Re-running Targets resets it to the math.

alter table public.daily_targets
  add column source    text not null default 'math' check (source in ('math', 'ai')),
  add column ai_reason text;
