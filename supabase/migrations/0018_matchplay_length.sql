-- Matchplay length: decided against the scheduled length (18 or 9), which is inferred from how TrackMan
-- ends a matchplay game (it stops on the hole where the match is decided). Games that stop without a
-- decision are registered as "not finished" with the standing after the last hole both played.
create or replace function public.compute_match(p_r1 uuid, p_r2 uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  r1 rounds%rowtype; r2 rounds%rowtype;
  hi1 numeric; hi2 numeric; ch1 int; ch2 int; diff int; recv int; tm_strokes boolean;
  hs jsonb := '[]'; h record; s1 int; s2 int; net1 int; net2 int; res int;
  st int; np int; n int; cand int; i int; x jsonb; stat int[] := '{}';
  done boolean := false; margin int := 0; remaining int := 0; winner int := 0; detail jsonb := '[]'; finished boolean;
begin
  select * into r1 from rounds where id = p_r1;
  select * into r2 from rounds where id = p_r2;
  hi1 := coalesce((r1.conditions->>'tm_hcp')::numeric, public.hcp_on(r1.owner_id, r1.played_on));
  hi2 := coalesce((r2.conditions->>'tm_hcp')::numeric, public.hcp_on(r2.owner_id, r2.played_on));
  ch1 := coalesce(round((r1.conditions->>'tm_course_hcp')::numeric)::int, public.course_hcp(hi1, r1.course_name, r1.tee_name));
  ch2 := coalesce(round((r2.conditions->>'tm_course_hcp')::numeric)::int, public.course_hcp(hi2, r2.course_name, r2.tee_name));
  diff := case when ch1 is null or ch2 is null then 0 else abs(ch1 - ch2) end;
  recv := case when coalesce(ch1, 0) > coalesce(ch2, 0) then 1 else 2 end;
  tm_strokes := coalesce(r1.conditions->>'tm_game_score', '') ilike 'match%'
    and not exists (select 1 from round_holes y where y.round_id in (p_r1, p_r2) and y.hcp_strokes is null);

  -- pass 1: net result per hole and running status
  st := 0;
  for h in
    select a.hole_no, a.par, coalesce(a.stroke_index, b.stroke_index) si, a.strokes g1, b.strokes g2, a.hcp_strokes h1, b.hcp_strokes h2
    from round_holes a join round_holes b on b.round_id = p_r2 and b.hole_no = a.hole_no
    where a.round_id = p_r1 order by a.hole_no
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

  -- scheduled length: the one where the match was decided exactly on the last hole played, else 18/9
  n := null;
  if np in (9, 18) then n := np; end if;
  if n is null then
    foreach cand in array array[18, 9] loop
      if cand > np and np > 0 and abs(stat[np]) > cand - np and (np = 1 or abs(stat[np - 1]) <= cand - (np - 1)) then n := cand; exit; end if;
    end loop;
  end if;
  if n is null then n := 18; end if;   -- stopped early without a decision: an 18-hole match

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
revoke execute on function public.compute_match(uuid, uuid) from public, anon, authenticated;

-- detect_matches: note "not finished" from compute_match
do $$
declare src text;
begin
  src := pg_get_functiondef('public.detect_matches()'::regprocedure);
  src := replace(src, 'case when not (pr.done1 and pr.done2) and (m->>''remaining'')::int = 0 then format(''Ikke fullført: stilling etter %s hull'', m->>''n'') end',
                      'case when not (m->>''finished'')::boolean then format(''Ikke fullført: stilling etter %s av %s hull'', m->>''n'', m->>''scheduled'') end');
  execute src;
end $$;
select public.detect_matches();
