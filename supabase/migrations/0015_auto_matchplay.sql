-- Automatic matchplay from TrackMan: when two app users have played the same simulator course on the
-- same day (Wednesday, starting within 3 hours of each other), the match is computed hole by hole with
-- full handicap difference and stored in matches. Handicap index per player is kept with history.

-- Player profile: display name, visible to other signed-in players
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists read_all on public.profiles;
create policy read_all on public.profiles for select to authenticated using (true);
drop policy if exists write_own on public.profiles;
create policy write_own on public.profiles for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Handicap index with history (the value valid on the match day is used)
create table if not exists public.hcp_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  valid_from date not null,
  hcp_index numeric(4,1) not null check (hcp_index between -10 and 54),
  created_at timestamptz not null default now(),
  primary key (user_id, valid_from)
);
alter table public.hcp_history enable row level security;
drop policy if exists read_all on public.hcp_history;
create policy read_all on public.hcp_history for select to authenticated using (true);
drop policy if exists write_own on public.hcp_history;
create policy write_own on public.hcp_history for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Matches get the link to the two rounds and the hole-by-hole detail
alter table public.matches
  add column if not exists auto boolean not null default false,
  add column if not exists p1_user uuid references auth.users(id),
  add column if not exists p2_user uuid references auth.users(id),
  add column if not exists p1_round uuid references public.rounds(id) on delete set null,
  add column if not exists p2_round uuid references public.rounds(id) on delete set null,
  add column if not exists p1_ch int,
  add column if not exists p2_ch int,
  add column if not exists holes jsonb;
create unique index if not exists matches_rounds_uq on public.matches(p1_round, p2_round) where p1_round is not null;

create or replace function public.player_name(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select display_name from profiles where user_id = p_user),
                  initcap(split_part((select email from auth.users where id = p_user), '@', 1)), 'Spiller')
$$;

create or replace function public.hcp_on(p_user uuid, p_day date) returns numeric
language sql stable security definer set search_path = public as $$
  select hcp_index from hcp_history where user_id = p_user and valid_from <= p_day order by valid_from desc limit 1
$$;

-- Course handicap (WHS): HI × slope/113 + (CR − par), using the TrackMan tee that was played (men's tee).
create or replace function public.course_hcp(p_hi numeric, p_course text, p_tee text) returns int
language sql stable security definer set search_path = public as $$
  with c as (select tees from tm_courses where name_key = public.name_key(p_course) order by updated_at desc limit 1),
  t as (
    select (x->>'slope')::numeric slope, (x->>'courseRating')::numeric cr, (x->>'par')::numeric par
    from c, jsonb_array_elements(c.tees) x
    where lower(x->>'name') = lower(coalesce(p_tee, '')) and coalesce(x->>'gender', 'MALE') = 'MALE'
    limit 1
  )
  select case when p_hi is null then null
              when exists (select 1 from t where slope is not null and cr is not null and par is not null)
                then (select round(p_hi * slope / 113 + (cr - par))::int from t)
              else round(p_hi)::int end
$$;

-- Hole-by-hole matchplay for two rounds. p1 = first round's player.
create or replace function public.compute_match(p_r1 uuid, p_r2 uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  r1 rounds%rowtype; r2 rounds%rowtype;
  hi1 numeric; hi2 numeric; ch1 int; ch2 int; diff int; recv int; -- recv: 1 = p1 receives, 2 = p2 receives
  st int := 0; n int; i int := 0; left_ int; margin int := 0; remaining int := 0; winner int := 0; done boolean := false;
  h record; s1 int; s2 int; net1 int; net2 int; res int; detail jsonb := '[]'; pre_done boolean;
begin
  select * into r1 from rounds where id = p_r1;
  select * into r2 from rounds where id = p_r2;
  hi1 := public.hcp_on(r1.owner_id, r1.played_on);
  hi2 := public.hcp_on(r2.owner_id, r2.played_on);
  ch1 := public.course_hcp(hi1, r1.course_name, r1.tee_name);
  ch2 := public.course_hcp(hi2, r2.course_name, r2.tee_name);
  diff := abs(coalesce(ch1, 0) - coalesce(ch2, 0));
  if ch1 is null or ch2 is null then diff := 0; end if;
  recv := case when coalesce(ch1, 0) > coalesce(ch2, 0) then 1 else 2 end;

  select count(*) into n from round_holes a join round_holes b on b.round_id = p_r2 and b.hole_no = a.hole_no where a.round_id = p_r1;
  for h in
    select a.hole_no, a.par, coalesce(a.stroke_index, b.stroke_index) si, a.strokes g1, b.strokes g2
    from round_holes a join round_holes b on b.round_id = p_r2 and b.hole_no = a.hole_no
    where a.round_id = p_r1 order by a.hole_no
  loop
    i := i + 1; pre_done := done;
    s1 := 0; s2 := 0;
    if diff > 0 and h.si is not null then
      if recv = 1 then s1 := diff / 18 + case when h.si <= diff % 18 then 1 else 0 end;
      else s2 := diff / 18 + case when h.si <= diff % 18 then 1 else 0 end; end if;
    end if;
    net1 := case when h.g1 is null then null else h.g1 - s1 end;
    net2 := case when h.g2 is null then null else h.g2 - s2 end;
    res := case when net1 is null and net2 is null then 0 when net1 is null then -1 when net2 is null then 1
                when net1 < net2 then 1 when net1 > net2 then -1 else 0 end;
    if not done then
      st := st + res;
      left_ := n - i;
      if abs(st) > left_ then done := true; margin := abs(st); remaining := left_; winner := case when st > 0 then 1 else 2 end; end if;
    end if;
    detail := detail || jsonb_build_object('hole', h.hole_no, 'par', h.par, 'si', h.si, 'g1', h.g1, 'g2', h.g2,
                                           's1', s1, 's2', s2, 'res', res, 'status', st, 'counted', not pre_done);
  end loop;
  if not done then margin := abs(st); remaining := 0; winner := case when st > 0 then 1 when st < 0 then 2 else 0 end; end if;
  return jsonb_build_object('winner', winner, 'margin', margin, 'remaining', remaining,
    'p1_hcp', hi1, 'p2_hcp', hi2, 'p1_ch', ch1, 'p2_ch', ch2, 'holes', detail, 'n', n);
end $$;

-- Find new pairs and store/refresh auto matches. Runs after every sync; safe to run any time.
create or replace function public.detect_matches() returns int
language plpgsql security definer set search_path = public as $$
declare pr record; m jsonb; k int := 0;
begin
  for pr in
    select a.id r1, b.id r2, a.owner_id u1, b.owner_id u2, a.played_on, a.course_name
    from rounds a
    join sessions sa on sa.id = a.session_id
    join rounds b on b.kind = 'simulator' and b.owner_id <> a.owner_id and b.played_on = a.played_on
      and public.name_key(b.course_name) = public.name_key(a.course_name) and b.superseded_by is null and b.counts_in_stats
    join sessions sb on sb.id = b.session_id
    join auth.users ua on ua.id = a.owner_id
    join auth.users ub on ub.id = b.owner_id
    where a.kind = 'simulator' and a.superseded_by is null and a.counts_in_stats
      and ua.created_at < ub.created_at                      -- each pair once; p1 = the older account
      and extract(isodow from a.played_on) = 3               -- Wednesday
      and abs(extract(epoch from sa.started_at - sb.started_at)) < 3 * 3600
      and a.holes_played = b.holes_played
  loop
    m := public.compute_match(pr.r1, pr.r2);
    insert into matches(created_by, played_on, course_name, kind, p1_name, p1_hcp, p2_name, p2_hcp, winner, margin, remaining,
                        auto, p1_user, p2_user, p1_round, p2_round, p1_ch, p2_ch, holes, note)
    values (pr.u1, pr.played_on, btrim(pr.course_name, E' ‎'), 'simulator', public.player_name(pr.u1), (m->>'p1_hcp')::numeric,
            public.player_name(pr.u2), (m->>'p2_hcp')::numeric, (m->>'winner')::int, (m->>'margin')::int, (m->>'remaining')::int,
            true, pr.u1, pr.u2, pr.r1, pr.r2, (m->>'p1_ch')::int, (m->>'p2_ch')::int, m->'holes',
            case when m->>'p1_hcp' is null or m->>'p2_hcp' is null then 'Uten hcp for begge: regnet brutto' end)
    on conflict (p1_round, p2_round) where p1_round is not null do update
      set p1_name = excluded.p1_name, p2_name = excluded.p2_name, p1_hcp = excluded.p1_hcp, p2_hcp = excluded.p2_hcp,
          winner = excluded.winner, margin = excluded.margin, remaining = excluded.remaining,
          p1_ch = excluded.p1_ch, p2_ch = excluded.p2_ch, holes = excluded.holes, note = excluded.note;
    k := k + 1;
  end loop;
  return k;
end $$;
revoke execute on function public.detect_matches() from public, anon;
grant execute on function public.detect_matches() to authenticated;
revoke execute on function public.compute_match(uuid, uuid) from public, anon, authenticated;

-- Save my handicap index (from a date) and my name; recompute my auto matches
create or replace function public.set_profile(p_name text, p_hcp numeric default null, p_from date default current_date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o uuid := auth.uid();
begin
  if o is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if coalesce(btrim(p_name), '') <> '' then
    insert into profiles(user_id, display_name) values (o, btrim(p_name))
    on conflict (user_id) do update set display_name = excluded.display_name, updated_at = now();
  end if;
  if p_hcp is not null then
    insert into hcp_history(user_id, valid_from, hcp_index) values (o, coalesce(p_from, current_date), p_hcp)
    on conflict (user_id, valid_from) do update set hcp_index = excluded.hcp_index;
  end if;
  return jsonb_build_object('matches', public.detect_matches());
end $$;
revoke execute on function public.set_profile(text, numeric, date) from public, anon;
grant execute on function public.set_profile(text, numeric, date) to authenticated;

-- Run detection after every sync that brings in a new round
do $$
declare src text;
begin
  src := pg_get_functiondef('public.sync_import(jsonb)'::regprocedure);
  if position('detect_matches' in src) = 0 then
    src := replace(src, 'return res;', 'if coalesce((res->>''round_new'')::boolean, false) then perform public.detect_matches(); end if;
  return res;');
    execute src;
  end if;
end $$;
