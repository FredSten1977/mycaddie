-- Matchplay from the TrackMan scorecard itself.
-- Before: a match needed both players' rounds in the app, on a Wednesday.
-- Now: every simulator round knows who was on the scorecard (tm_participants) and, from extension 0.4.0,
-- every player's holes (tm_players). A match is found when exactly two app users are on the same scorecard and
-- the game was matchplay (any day) or it was a Wednesday game. One player's round is enough.
-- Nothing is deleted: existing matches are kept and updated in place (match_key).

-- 1) TrackMan player name per app user (learned from the scorecards; used to recognise the users on a scorecard)
alter table public.profiles add column if not exists tm_name text;

with cand as (
  select r.owner_id, x->>'name' nm, count(*) n
  from rounds r, jsonb_array_elements(r.conditions->'tm_participants') x
  where r.kind = 'simulator' and jsonb_typeof(r.conditions->'tm_participants') = 'array'
    and (x->>'name' = r.conditions->>'tm_player_name'
         or (r.conditions->>'tm_player_name' is null and (x->>'hcp')::numeric = (r.conditions->>'tm_hcp')::numeric))
  group by 1, 2
), best as (select distinct on (owner_id) owner_id, nm from cand order by owner_id, n desc)
update public.profiles p set tm_name = b.nm from best b where p.user_id = b.owner_id and p.tm_name is null;

-- 2) A stable key per match, so a match found from either player's round is the same row
alter table public.matches add column if not exists match_key text;
update public.matches set match_key = concat_ws('|', p1_user, p2_user, played_on, public.name_key(course_name))
 where auto and match_key is null and p1_user is not null and p2_user is not null;
create unique index if not exists matches_key_uq on public.matches (match_key) where match_key is not null;

-- 3) Match engine on plain hole lists: [{hole_no, par, stroke_index, strokes, hcp_strokes}]
create or replace function public.compute_match_core(h1j jsonb, h2j jsonb, hi1 numeric, hi2 numeric, ch1 int, ch2 int,
                                                     tm_strokes boolean, p_sched int) returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  diff int; recv int; hs jsonb := '[]'; h record; s1 int; s2 int; net1 int; net2 int; res int;
  st int := 0; np int; n int; cand int; i int; x jsonb; stat int[] := '{}';
  done boolean := false; margin int := 0; remaining int := 0; winner int := 0; detail jsonb := '[]'; finished boolean;
begin
  diff := case when ch1 is null or ch2 is null then 0 else abs(ch1 - ch2) end;
  recv := case when coalesce(ch1, 0) > coalesce(ch2, 0) then 1 else 2 end;

  -- pass 1: net result per hole and running status (holes both players played)
  for h in
    select (a->>'hole_no')::int hole_no, (a->>'par')::int par,
           coalesce((a->>'stroke_index')::int, (b->>'stroke_index')::int) si,
           (a->>'strokes')::int g1, (b->>'strokes')::int g2, (a->>'hcp_strokes')::int h1, (b->>'hcp_strokes')::int h2
    from jsonb_array_elements(coalesce(h1j, '[]')) a
    join jsonb_array_elements(coalesce(h2j, '[]')) b on (b->>'hole_no')::int = (a->>'hole_no')::int
    order by 1
  loop
    s1 := 0; s2 := 0;
    if tm_strokes then s1 := coalesce(h.h1, 0); s2 := coalesce(h.h2, 0);
    elsif diff > 0 and h.si is not null then
      if recv = 1 then s1 := diff / 18 + case when h.si <= diff % 18 then 1 else 0 end;
      else s2 := diff / 18 + case when h.si <= diff % 18 then 1 else 0 end; end if;
    end if;
    net1 := case when h.g1 is null then null else h.g1 - s1 end;
    net2 := case when h.g2 is null then null else h.g2 - s2 end;
    res := case when net1 is null and net2 is null then 0 when net1 is null then -1 when net2 is null then 1
                when net1 < net2 then 1 when net1 > net2 then -1 else 0 end;
    st := st + res; stat := stat || st;
    hs := hs || jsonb_build_object('hole', h.hole_no, 'par', h.par, 'si', h.si, 'g1', h.g1, 'g2', h.g2, 's1', s1, 's2', s2, 'res', res);
  end loop;
  np := coalesce(array_length(stat, 1), 0);

  -- scheduled length: from TrackMan when known, else the one where the match was decided on the last hole played
  n := case when p_sched in (9, 18) then p_sched end;
  if n is null and np in (9, 18) then n := np; end if;
  if n is null then
    foreach cand in array array[18, 9] loop
      if cand > np and np > 0 and abs(stat[np]) > cand - np and (np = 1 or abs(stat[np - 1]) <= cand - (np - 1)) then n := cand; exit; end if;
    end loop;
  end if;
  if n is null then n := 18; end if;
  if n < np then n := np; end if;

  -- pass 2: decide
  for i in 1 .. np loop
    x := hs->(i - 1);
    detail := detail || (x || jsonb_build_object('status', stat[i], 'counted', not done));
    if not done and abs(stat[i]) > n - i then done := true; margin := abs(stat[i]); remaining := n - i; winner := case when stat[i] > 0 then 1 else 2 end; end if;
  end loop;
  finished := done or np >= n;
  if not done then margin := abs(coalesce(stat[np], 0)); remaining := 0; winner := case when coalesce(stat[np], 0) > 0 then 1 when coalesce(stat[np], 0) < 0 then 2 else 0 end; end if;
  return jsonb_build_object('winner', winner, 'margin', margin, 'remaining', remaining,
    'p1_hcp', hi1, 'p2_hcp', hi2, 'p1_ch', ch1, 'p2_ch', ch2, 'holes', detail, 'n', np, 'scheduled', n,
    'finished', finished, 'tm_strokes', tm_strokes);
end $$;
revoke execute on function public.compute_match_core(jsonb, jsonb, numeric, numeric, int, int, boolean, int) from public, anon, authenticated;

create or replace function public.round_hole_list(p_round uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('hole_no', hole_no, 'par', par, 'stroke_index', stroke_index,
                                               'strokes', strokes, 'hcp_strokes', hcp_strokes) order by hole_no), '[]')
  from round_holes where round_id = p_round and strokes is not null
$$;
revoke execute on function public.round_hole_list(uuid) from public, anon, authenticated;

-- kept for compatibility: two rounds in the app
create or replace function public.compute_match(p_r1 uuid, p_r2 uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r1 rounds%rowtype; r2 rounds%rowtype; hi1 numeric; hi2 numeric; ch1 int; ch2 int; h1 jsonb; h2 jsonb; tm boolean;
begin
  select * into r1 from rounds where id = p_r1;
  select * into r2 from rounds where id = p_r2;
  hi1 := coalesce((r1.conditions->>'tm_hcp')::numeric, public.hcp_on(r1.owner_id, r1.played_on));
  hi2 := coalesce((r2.conditions->>'tm_hcp')::numeric, public.hcp_on(r2.owner_id, r2.played_on));
  ch1 := coalesce(round((r1.conditions->>'tm_course_hcp')::numeric)::int, public.course_hcp(hi1, r1.course_name, r1.tee_name));
  ch2 := coalesce(round((r2.conditions->>'tm_course_hcp')::numeric)::int, public.course_hcp(hi2, r2.course_name, r2.tee_name));
  h1 := public.round_hole_list(p_r1); h2 := public.round_hole_list(p_r2);
  tm := coalesce(r1.conditions->>'tm_game_score', '') ilike 'match%'
        and not exists (select 1 from jsonb_array_elements(h1 || h2) e where e->'hcp_strokes' is null or e->>'hcp_strokes' is null);
  return public.compute_match_core(h1, h2, hi1, hi2, ch1, ch2, tm, (r1.conditions->>'tm_holes_to_play')::int);
end $$;
revoke execute on function public.compute_match(uuid, uuid) from public, anon, authenticated;

-- 4) Find matches from the scorecards
create or replace function public.detect_matches() returns integer
language plpgsql security definer set search_path = public as $$
declare
  g record; m jsonb; k int := 0; r1 rounds%rowtype; r2 rounds%rowtype; any_r rounds%rowtype;
  n1 text; n2 text; h1 jsonb; h2 jsonb; alt jsonb; p1 jsonb; p2 jsonb;
  hi1 numeric; hi2 numeric; ch1 int; ch2 int; tm boolean; game text; sched int;
begin
  for g in
    with u as (select p.user_id, p.tm_name, au.created_at from profiles p join auth.users au on au.id = p.user_id
               where p.tm_name is not null),
    c as (
      select r.id, r.owner_id, r.played_on, public.name_key(r.course_name) ck, r.course_name, r.holes_played,
             (select array_agg(u.user_id order by u.created_at, u.user_id) from u
               where exists (select 1 from jsonb_array_elements(r.conditions->'tm_participants') x where x->>'name' = u.tm_name)) users
      from rounds r
      where r.kind = 'simulator' and r.superseded_by is null and r.holes_played >= 6
        and jsonb_typeof(r.conditions->'tm_participants') = 'array'
        and (coalesce(r.conditions->>'tm_game_score', '') ilike 'match%' or extract(isodow from r.played_on) = 3)
    )
    select c.users[1] u1, c.users[2] u2, c.played_on, c.ck, min(btrim(c.course_name, E' ‎')) course_name,
           (array_agg(c.id order by c.holes_played desc) filter (where c.owner_id = c.users[1]))[1] r1,
           (array_agg(c.id order by c.holes_played desc) filter (where c.owner_id = c.users[2]))[1] r2
    from c where cardinality(c.users) = 2 and c.owner_id = any (c.users)
    group by 1, 2, 3, 4
  loop
    r1 := null; r2 := null;
    if g.r1 is not null then select * into r1 from rounds where id = g.r1; end if;
    if g.r2 is not null then select * into r2 from rounds where id = g.r2; end if;
    any_r := case when g.r1 is not null then r1 else r2 end;
    select tm_name into n1 from profiles where user_id = g.u1;
    select tm_name into n2 from profiles where user_id = g.u2;

    -- each side: own round in the app, or that player's scorecard carried in the other player's round (whichever has more holes)
    h1 := case when g.r1 is not null then public.round_hole_list(g.r1) else '[]' end;
    select x->'holes' into alt from jsonb_array_elements(coalesce(r2.conditions->'tm_players', '[]')) x where x->>'name' = n1 limit 1;
    if jsonb_array_length(coalesce(alt, '[]')) > jsonb_array_length(h1) then h1 := alt; end if;
    alt := null;
    h2 := case when g.r2 is not null then public.round_hole_list(g.r2) else '[]' end;
    select x->'holes' into alt from jsonb_array_elements(coalesce(r1.conditions->'tm_players', '[]')) x where x->>'name' = n2 limit 1;
    if jsonb_array_length(coalesce(alt, '[]')) > jsonb_array_length(h2) then h2 := alt; end if;
    alt := null;
    continue when jsonb_array_length(h1) < 6 or jsonb_array_length(h2) < 6;

    -- handicap as on the TrackMan scorecard, else the profile
    select x into p1 from jsonb_array_elements(any_r.conditions->'tm_participants') x where x->>'name' = n1 limit 1;
    select x into p2 from jsonb_array_elements(any_r.conditions->'tm_participants') x where x->>'name' = n2 limit 1;
    hi1 := coalesce((r1.conditions->>'tm_hcp')::numeric, (p1->>'hcp')::numeric, public.hcp_on(g.u1, g.played_on));
    hi2 := coalesce((r2.conditions->>'tm_hcp')::numeric, (p2->>'hcp')::numeric, public.hcp_on(g.u2, g.played_on));
    ch1 := coalesce(round((r1.conditions->>'tm_course_hcp')::numeric)::int, round((p1->>'course_hcp')::numeric)::int,
                    public.course_hcp(hi1, g.course_name, coalesce(r1.tee_name, p1->>'tee')));
    ch2 := coalesce(round((r2.conditions->>'tm_course_hcp')::numeric)::int, round((p2->>'course_hcp')::numeric)::int,
                    public.course_hcp(hi2, g.course_name, coalesce(r2.tee_name, p2->>'tee')));
    game := coalesce(r1.conditions->>'tm_game_score', r2.conditions->>'tm_game_score', '');
    tm := game ilike 'match%'
          and not exists (select 1 from jsonb_array_elements(h1 || h2) e where e->>'hcp_strokes' is null);
    sched := coalesce((r1.conditions->>'tm_holes_to_play')::int, (r2.conditions->>'tm_holes_to_play')::int);

    m := public.compute_match_core(h1, h2, hi1, hi2, ch1, ch2, tm, sched);
    insert into matches(created_by, played_on, course_name, kind, p1_name, p1_hcp, p2_name, p2_hcp, winner, margin, remaining,
                        auto, p1_user, p2_user, p1_round, p2_round, p1_ch, p2_ch, holes, note, match_key)
    values (g.u1, g.played_on, g.course_name, 'simulator', public.player_name(g.u1), (m->>'p1_hcp')::numeric,
            public.player_name(g.u2), (m->>'p2_hcp')::numeric, (m->>'winner')::int, (m->>'margin')::int, (m->>'remaining')::int,
            true, g.u1, g.u2, g.r1, g.r2, (m->>'p1_ch')::int, (m->>'p2_ch')::int, m->'holes',
            concat_ws('. ', case when not (m->>'finished')::boolean then format('Ikke fullført: stilling etter %s av %s hull', m->>'n', m->>'scheduled') end,
                 case when m->>'p1_hcp' is null or m->>'p2_hcp' is null then 'Uten hcp for begge: regnet brutto' end,
                 case when (m->>'tm_strokes')::boolean then 'Slag som i TrackMan-spillet' end),
            concat_ws('|', g.u1, g.u2, g.played_on, g.ck))
    on conflict (match_key) where match_key is not null do update
      set p1_name = excluded.p1_name, p2_name = excluded.p2_name, p1_hcp = excluded.p1_hcp, p2_hcp = excluded.p2_hcp,
          winner = excluded.winner, margin = excluded.margin, remaining = excluded.remaining,
          p1_round = coalesce(excluded.p1_round, matches.p1_round), p2_round = coalesce(excluded.p2_round, matches.p2_round),
          p1_ch = excluded.p1_ch, p2_ch = excluded.p2_ch, holes = excluded.holes, note = excluded.note;
    k := k + 1;
  end loop;
  return k;
end $$;

-- 5) Sync: learn the user's TrackMan name; list known rounds whose scorecard should be read again
do $$
declare src text;
begin
  src := pg_get_functiondef('public.sync_import(jsonb)'::regprocedure);
  if position('tm_player_name' in src) = 0 then
    src := replace(src, E'  res := public.import_trackman(p || jsonb_build_object(''channel'', ''extension''));',
      E'  res := public.import_trackman(p || jsonb_build_object(''channel'', ''extension''));\n' ||
      E'  update profiles set tm_name = p->''round''->''conditions''->>''tm_player_name''\n' ||
      E'   where user_id = auth.uid() and nullif(p->''round''->''conditions''->>''tm_player_name'', '''') is not null\n' ||
      E'     and tm_name is distinct from p->''round''->''conditions''->>''tm_player_name'';');
    if position('tm_player_name' in src) = 0 then raise exception 'sync_import patch did not apply'; end if;
    execute src;
  end if;
end $$;

create or replace function public.sync_refresh_activities() returns setof text
language sql stable security definer set search_path = public as $$
  select distinct s.external_id from sources s
  join rounds r on r.source_id = s.id and r.kind = 'simulator'
  where s.owner_id = public.current_owner() and auth.uid() = public.current_owner() and s.source_type = 'trackman_api'
    and coalesce((r.conditions->>'tm_meta_v')::int, 0) < 3
$$;
revoke execute on function public.sync_refresh_activities() from public, anon;
grant execute on function public.sync_refresh_activities() to authenticated;

select public.detect_matches();
