-- Seasons for the match module (matchplay + warm-up). A season runs from starts_on until the next
-- season starts. New seasons are added with one insert; nothing else changes.
create table if not exists public.match_seasons (
  name text primary key,
  starts_on date not null unique,
  created_at timestamptz not null default now()
);
alter table public.match_seasons enable row level security;
drop policy if exists read_all on public.match_seasons;
create policy read_all on public.match_seasons for select to authenticated using (true);

insert into public.match_seasons(name, starts_on) values
  ('2026', '2000-01-01'),   -- everything up to and including 2026-11-20
  ('2027', '2026-11-21')    -- blank sheet from 2026-11-21
on conflict (name) do nothing;
