-- Matchplay between app users (e.g. every Wednesday). Everyone signed in to the app sees the matches;
-- only the person who registered a match can change or delete it.
create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null default auth.uid() references auth.users(id),
  played_on date not null,
  course_name text not null,
  kind round_kind not null default 'outdoor',
  p1_name text not null,
  p1_hcp numeric(4,1),
  p2_name text not null,
  p2_hcp numeric(4,1),
  winner smallint not null check (winner in (0, 1, 2)),          -- 0 = delt
  margin smallint not null default 0 check (margin between 0 and 10),    -- hull opp ved slutt
  remaining smallint not null default 0 check (remaining between 0 and 9), -- hull igjen da matchen var avgjort (3&2 → 2)
  note text,
  created_at timestamptz not null default now(),
  check ((winner = 0 and margin = 0 and remaining = 0) or (winner > 0 and margin >= 1 and remaining <= margin))
);
create index if not exists matches_played_on on public.matches(played_on desc);
alter table public.matches enable row level security;
drop policy if exists read_all on public.matches;
create policy read_all on public.matches for select to authenticated using (true);
drop policy if exists insert_own on public.matches;
create policy insert_own on public.matches for insert to authenticated with check (created_by = (select auth.uid()));
drop policy if exists update_own on public.matches;
create policy update_own on public.matches for update to authenticated using (created_by = (select auth.uid())) with check (created_by = (select auth.uid()));
drop policy if exists delete_own on public.matches;
create policy delete_own on public.matches for delete to authenticated using (created_by = (select auth.uid()));
