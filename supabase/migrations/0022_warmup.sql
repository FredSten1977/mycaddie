-- Warm-up competition (Virtual Range) between app users, e.g. before the Wednesday match.
-- Rules (v1): each player goes through the bag; you may move on from a club when you have
-- 2 balls in the big circle or 1 ball in the small circle. Fewest shots wins.
-- Detection: both players have a VIRTUAL_RANGE session the same (Oslo) day, started within 3 hours.
--   status 'auto'      = there is also a match between them that day
--   status 'kandidat'  = no match that day; one tap to confirm
--   status 'bekreftet' / 'avvist' = set by a player; never overwritten by detection
-- Hits use TrackMan's circle target per stroke (raw.target.radius / tourRadius), fetched by
-- extension 0.5.0. Without it, stroke play and club matchplay still work (they only need shot counts).

create table if not exists public.warmup_duels (
  id uuid primary key default gen_random_uuid(),
  played_on date not null,
  p1_user uuid not null references auth.users(id) on delete cascade,
  p2_user uuid not null references auth.users(id) on delete cascade,
  p1_session uuid not null references public.sessions(id) on delete cascade,
  p2_session uuid not null references public.sessions(id) on delete cascade,
  p1_name text not null,
  p2_name text not null,
  status text not null default 'kandidat' check (status in ('auto', 'kandidat', 'bekreftet', 'avvist')),
  rule_version text not null default 'v1',
  e1 jsonb not null,          -- per-club evaluation, player 1
  e2 jsonb not null,          -- per-club evaluation, player 2
  result jsonb not null,      -- three scoring systems
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (p1_session, p2_session)
);
create index if not exists warmup_duels_day on public.warmup_duels(played_on desc);
alter table public.warmup_duels enable row level security;
drop policy if exists read_all on public.warmup_duels;
create policy read_all on public.warmup_duels for select to authenticated using (true);
-- no direct writes: everything goes through the functions below

-- Club label used to pair the same club between two players
create or replace function public.warmup_club_key(p text) returns text
language sql immutable as $$ select lower(regexp_replace(coalesce(p, ''), '[^[:alnum:]]', '', 'g')) $$;

-- One session → consecutive club blocks with shots and hits.
create or replace function public.warmup_eval(p_session uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  r record; blocks jsonb := '[]'; cur jsonb := null; ck text := null;
  d numeric; big boolean; small boolean; rad numeric; trad numeric; tgt numeric;
  n int := 0; nb int := 0; ns int := 0; pts int := 0; hitdata boolean := true; okc int := 0;
  sh int; b int; s int; done_at int;
begin
  for r in
    select x.shot_time, coalesce(x.raw->>'club', x.club_raw) club_raw, coalesce(c.name, x.raw->>'club', x.club_raw) club_name,
           x.carry_m, x.carry_side_m,
           coalesce((x.raw->'target'->>'distance')::numeric, (x.raw->>'targetDistance')::numeric) tgt,
           (x.raw->'target'->>'radius')::numeric r1, (x.raw->'target'->>'tourRadius')::numeric r2
    from shots x left join clubs c on c.id = x.club_id
    where x.session_id = p_session
    order by x.shot_time, x.shot_no
  loop
    if ck is distinct from public.warmup_club_key(r.club_raw) then
      if cur is not null then blocks := blocks || cur; end if;
      ck := public.warmup_club_key(r.club_raw);
      cur := jsonb_build_object('club', ck, 'name', r.club_name, 'tgt', round(r.tgt), 'shots', 0, 'big', 0, 'small', 0,
                                'done_at', null, 'hits', '[]'::jsonb, 'd', '[]'::jsonb);
    end if;
    n := n + 1;
    sh := (cur->>'shots')::int + 1; b := (cur->>'big')::int; s := (cur->>'small')::int;
    rad := greatest(r.r1, r.r2); trad := least(r.r1, r.r2); tgt := r.tgt;
    d := case when r.carry_m is null or tgt is null then null else sqrt(power(r.carry_m - tgt, 2) + power(coalesce(r.carry_side_m, 0), 2)) end;
    if rad is null or d is null then
      hitdata := false; big := null; small := null;
    else
      small := d <= trad; big := d <= rad;
      if small then s := s + 1; b := b + 1; pts := pts + 2; ns := ns + 1; nb := nb + 1;
      elsif big then b := b + 1; pts := pts + 1; nb := nb + 1; end if;
    end if;
    done_at := (cur->>'done_at')::int;
    if done_at is null and (s >= 1 or b >= 2) then done_at := sh; end if;
    cur := cur || jsonb_build_object('shots', sh, 'big', b, 'small', s, 'done_at', done_at,
                                     'hits', (cur->'hits') || coalesce(to_jsonb(case when small then 2 when big then 1 when big is null then null else 0 end), 'null'::jsonb),
                                     'd', (cur->'d') || coalesce(to_jsonb(round(d, 1)), 'null'::jsonb));
  end loop;
  if cur is not null then blocks := blocks || cur; end if;
  select count(*) into okc from jsonb_array_elements(blocks) z where (z->>'done_at')::int = (z->>'shots')::int;
  return jsonb_build_object('blocks', blocks, 'shots', n, 'clubs', jsonb_array_length(blocks),
    'big', nb, 'small', ns, 'points', pts, 'hit_data', hitdata and n > 0, 'ok_clubs', okc);
end $$;
revoke execute on function public.warmup_eval(uuid) from public, anon, authenticated;

-- Three scoring systems from two evaluations.
create or replace function public.warmup_score(e1 jsonb, e2 jsonb) returns jsonb
language plpgsql immutable as $$
declare
  s1 int := (e1->>'shots')::int; s2 int := (e2->>'shots')::int;
  sw int; st int := 0; i int := 0; n int; left_ int; done boolean := false; pre_done boolean; mw int := 0; mm int := 0; mr int := 0;
  holes jsonb := '[]'; r record; res int; eff1 numeric; eff2 numeric; ew int; a1 numeric; a2 numeric;
begin
  -- 1) stroke play: fewest shots per club (= fewest shots when both hit the same number of clubs);
  --    tie → more small-circle hits
  a1 := round(s1::numeric / nullif((e1->>'clubs')::int, 0), 2); a2 := round(s2::numeric / nullif((e2->>'clubs')::int, 0), 2);
  sw := case when a1 < a2 then 1 when a2 < a1 then 2
             when coalesce((e1->>'small')::int, 0) > coalesce((e2->>'small')::int, 0) then 1
             when coalesce((e2->>'small')::int, 0) > coalesce((e1->>'small')::int, 0) then 2 else 0 end;
  -- 2) matchplay per club: every club both of them hit is a hole, in player 1's order
  select count(*) into n from jsonb_array_elements(e1->'blocks') a join jsonb_array_elements(e2->'blocks') b on b->>'club' = a->>'club';
  for r in
    select a->>'club' club, a->>'name' name, (a->>'shots')::int a_s, (b->>'shots')::int b_s, ord
    from jsonb_array_elements(e1->'blocks') with ordinality t(a, ord)
    join lateral (select b from jsonb_array_elements(e2->'blocks') b where b->>'club' = a->>'club' limit 1) bb on true
    order by ord
  loop
    i := i + 1; pre_done := done;
    res := case when r.a_s < r.b_s then 1 when r.a_s > r.b_s then -1 else 0 end;
    if not done then
      st := st + res; left_ := n - i;
      if abs(st) > left_ then done := true; mm := abs(st); mr := left_; mw := case when st > 0 then 1 else 2 end; end if;
    end if;
    holes := holes || jsonb_build_object('club', r.club, 'name', r.name, 's1', r.a_s, 's2', r.b_s, 'res', res, 'status', st, 'counted', not pre_done);
  end loop;
  if not done then mm := abs(st); mr := 0; mw := case when st > 0 then 1 when st < 0 then 2 else 0 end; end if;
  -- 3) efficiency: circle points per shot (small = 2, big = 1); only with TrackMan circle data for both
  if coalesce((e1->>'hit_data')::boolean, false) and coalesce((e2->>'hit_data')::boolean, false) and s1 > 0 and s2 > 0 then
    eff1 := round((e1->>'points')::numeric / s1, 3); eff2 := round((e2->>'points')::numeric / s2, 3);
    ew := case when eff1 > eff2 then 1 when eff2 > eff1 then 2 else 0 end;
  end if;
  return jsonb_build_object(
    'stroke', jsonb_build_object('s1', s1, 's2', s2, 'a1', a1, 'a2', a2, 'winner', sw),
    'match', jsonb_build_object('winner', mw, 'margin', mm, 'remaining', mr, 'holes', holes, 'n', n),
    'eff', case when ew is null then null else jsonb_build_object('e1', eff1, 'e2', eff2, 'winner', ew) end);
end $$;

-- Find warm-ups and (re)compute them. Safe to run any time.
-- p_day + p_force: register the pair for that day even without the 3-hour rule (status 'bekreftet').
create or replace function public.detect_warmups(p_day date default null, p_force boolean default false) returns int
language plpgsql security definer set search_path = public as $$
declare pr record; e1 jsonb; e2 jsonb; k int := 0; st text; has_match boolean;
begin
  for pr in
    with vr as (
      select s.id, s.owner_id, s.started_at, (s.started_at at time zone 'Europe/Oslo')::date d,
             (select count(*) from shots x where x.session_id = s.id) n
      from sessions s where s.trackman_kind = 'VIRTUAL_RANGE'
        and (p_day is null or (s.started_at at time zone 'Europe/Oslo')::date = p_day)
    ),
    pairs as (
      select a.id s1, b.id s2, a.owner_id u1, b.owner_id u2, a.d,
             row_number() over (partition by a.owner_id, b.owner_id, a.d
                                order by abs(extract(epoch from a.started_at - b.started_at)), a.n + b.n desc) rn
      from vr a join vr b on b.d = a.d and b.owner_id <> a.owner_id
      join auth.users ua on ua.id = a.owner_id join auth.users ub on ub.id = b.owner_id
      where ua.created_at < ub.created_at                   -- each pair once; p1 = the older account (as in matches)
        and a.n >= 3 and b.n >= 3
        and (p_force or abs(extract(epoch from a.started_at - b.started_at)) < 3 * 3600)
    )
    select * from pairs where rn = 1
  loop
    e1 := public.warmup_eval(pr.s1);
    e2 := public.warmup_eval(pr.s2);
    if not p_force and ((e1->>'clubs')::int < 3 or (e2->>'clubs')::int < 3) then continue; end if;
    select exists (select 1 from matches m where m.played_on = pr.d
                   and ((m.p1_user = pr.u1 and m.p2_user = pr.u2) or (m.p1_user = pr.u2 and m.p2_user = pr.u1))) into has_match;
    st := case when p_force then 'bekreftet' when has_match then 'auto' else 'kandidat' end;
    -- a different session pair the same day replaces an undecided one
    delete from warmup_duels w where w.played_on = pr.d and w.p1_user = pr.u1 and w.p2_user = pr.u2
      and (w.p1_session, w.p2_session) <> (pr.s1, pr.s2) and (p_force or w.status in ('auto', 'kandidat'));
    insert into warmup_duels(played_on, p1_user, p2_user, p1_session, p2_session, p1_name, p2_name, status, e1, e2, result)
    values (pr.d, pr.u1, pr.u2, pr.s1, pr.s2, public.player_name(pr.u1), public.player_name(pr.u2), st, e1, e2, public.warmup_score(e1, e2))
    on conflict (p1_session, p2_session) do update
      set e1 = excluded.e1, e2 = excluded.e2, result = excluded.result, p1_name = excluded.p1_name, p2_name = excluded.p2_name,
          status = case when p_force then 'bekreftet'
                        when warmup_duels.status in ('bekreftet', 'avvist') then warmup_duels.status
                        else excluded.status end,
          updated_at = now();
    k := k + 1;
  end loop;
  return k;
end $$;
revoke execute on function public.detect_warmups(date, boolean) from public, anon;
grant execute on function public.detect_warmups(date, boolean) to authenticated;

-- A player confirms or rejects a warm-up
create or replace function public.warmup_set_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('bekreftet', 'avvist') then raise exception 'ugyldig status' using errcode = '22023'; end if;
  update warmup_duels set status = p_status, updated_at = now()
  where id = p_id and auth.uid() in (p1_user, p2_user);
  if not found then raise exception 'not allowed' using errcode = '42501'; end if;
end $$;
revoke execute on function public.warmup_set_status(uuid, text) from public, anon;
grant execute on function public.warmup_set_status(uuid, text) to authenticated;

-- Extension 0.5.0: Virtual Range sessions whose shots do not yet have TrackMan's circle target
create or replace function public.sync_target_refresh_activities() returns setof text
language sql stable security definer set search_path = public as $$
  select distinct s.external_id from sessions s
  where s.owner_id = auth.uid() and s.trackman_kind = 'VIRTUAL_RANGE' and s.external_id is not null
    and s.started_at > now() - interval '400 days'
    and exists (select 1 from shots x where x.session_id = s.id and not (x.raw ? 'target'))
$$;
revoke execute on function public.sync_target_refresh_activities() from public, anon;
grant execute on function public.sync_target_refresh_activities() to authenticated;

-- Extension 0.5.0: add target data to shots that were imported earlier (matched on session + shot time)
create or replace function public.sync_update_targets(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o uuid := auth.uid(); sid uuid; n int;
begin
  if o is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select id into sid from sessions where owner_id = o and external_id = p->'sessions'->0->>'external_id' limit 1;
  if sid is null then return jsonb_build_object('updated', 0); end if;
  update shots x set raw = x.raw || jsonb_build_object(
      'target', coalesce(j.v->'raw'->'target', 'null'::jsonb),
      'targetPosition', coalesce(j.v->'raw'->'targetPosition', 'null'::jsonb),
      'data', coalesce(j.v->'raw'->'data', 'null'::jsonb),
      'tags', coalesce(j.v->'raw'->'tags', 'null'::jsonb))
  from jsonb_array_elements(p->'shots') j(v)
  where x.session_id = sid and x.owner_id = o and x.shot_time = (j.v->>'shot_time')::timestamptz;
  get diagnostics n = row_count;
  -- strokes TrackMan no longer returns: mark as checked so they are not asked for again
  update shots set raw = raw || '{"target": null}'::jsonb where session_id = sid and owner_id = o and not (raw ? 'target');
  perform public.detect_warmups();
  return jsonb_build_object('updated', n);
end $$;
revoke execute on function public.sync_update_targets(jsonb) from public, anon;
grant execute on function public.sync_update_targets(jsonb) to authenticated;

-- Run warm-up detection after every sync that brings a Virtual Range session or a round
create or replace function public.sync_import(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare res jsonb;
begin
  if auth.uid() is null or auth.uid() <> public.current_owner() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if (p->'source'->>'type') <> 'trackman_api' then
    raise exception 'sync_import only accepts trackman_api sources' using errcode = '22023';
  end if;
  if jsonb_typeof(p->'round') is distinct from 'object' then
    p := p - 'round';
  end if;
  res := public.import_trackman(p || jsonb_build_object('channel', 'extension'));
  update profiles set tm_name = p->'round'->'conditions'->>'tm_player_name'
   where user_id = auth.uid() and nullif(p->'round'->'conditions'->>'tm_player_name', '') is not null
     and tm_name is distinct from p->'round'->'conditions'->>'tm_player_name';
  if (res->>'shots_new')::int > 0 then perform public.classify_shots_v1(); end if;
  if coalesce((res->>'round_new')::boolean, false) or coalesce((res->>'round_meta')::boolean, false) then perform public.detect_matches(); end if;
  if ((res->>'shots_new')::int > 0 and p->'sessions'->0->>'trackman_kind' = 'VIRTUAL_RANGE')
     or coalesce((res->>'round_new')::boolean, false) then
    perform public.detect_warmups();
  end if;
  return res;
end $$;

-- A match registered or recomputed later turns a candidate into 'auto'
create or replace function public.warmup_after_match() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update warmup_duels w set status = 'auto', updated_at = now()
  where w.status = 'kandidat' and w.played_on = new.played_on
    and ((w.p1_user = new.p1_user and w.p2_user = new.p2_user) or (w.p1_user = new.p2_user and w.p2_user = new.p1_user));
  return new;
end $$;
drop trigger if exists warmup_after_match on public.matches;
create trigger warmup_after_match after insert or update of played_on, p1_user, p2_user on public.matches
  for each row when (new.p1_user is not null and new.p2_user is not null) execute function public.warmup_after_match();
