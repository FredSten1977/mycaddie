-- Matchplay fixes after the first real Wednesday with the new sync:
-- 1) Matches that were stopped before 18 holes (both played the same holes, at least 6) are registered
--    with the standing after the last hole both played, and marked as not finished.
-- 2) When the TrackMan game itself was matchplay (MatchNet/Match…), TrackMan's own strokes per hole are used,
--    so the app shows exactly what the simulator showed. Otherwise: full difference on the lowest stroke index.

do $$
declare src text;
begin
  src := pg_get_functiondef('public.compute_match(uuid,uuid)'::regprocedure);
  if position('tm_strokes' in src) = 0 then
    src := replace(src, 'h record; s1 int;', 'h record; tm_strokes boolean; s1 int;');
    src := replace(src,
      'select a.hole_no, a.par, coalesce(a.stroke_index, b.stroke_index) si, a.strokes g1, b.strokes g2',
      'select a.hole_no, a.par, coalesce(a.stroke_index, b.stroke_index) si, a.strokes g1, b.strokes g2, a.hcp_strokes h1, b.hcp_strokes h2');
    src := replace(src, E'  select count(*) into n from round_holes a',
      E'  tm_strokes := coalesce(r1.conditions->>''tm_game_score'', '''') ilike ''match%''\n    and not exists (select 1 from round_holes x where x.round_id in (p_r1, p_r2) and x.hcp_strokes is null);\n  select count(*) into n from round_holes a');
    src := replace(src, E'    s1 := 0; s2 := 0;\n    if diff > 0',
      E'    s1 := 0; s2 := 0;\n    if tm_strokes then s1 := coalesce(h.h1, 0); s2 := coalesce(h.h2, 0);\n    elsif diff > 0');
    src := replace(src, E'''holes'', detail, ''n'', n);', E'''holes'', detail, ''n'', n, ''tm_strokes'', tm_strokes);');
    execute src;
  end if;

  src := pg_get_functiondef('public.detect_matches()'::regprocedure);
  if position('holes_played >= 6' in src) = 0 then
    src := replace(src, 'and b.superseded_by is null and b.counts_in_stats', 'and b.superseded_by is null and (b.counts_in_stats or b.holes_played >= 6)');
    src := replace(src, 'where a.kind = ''simulator'' and a.superseded_by is null and a.counts_in_stats', 'where a.kind = ''simulator'' and a.superseded_by is null and (a.counts_in_stats or a.holes_played >= 6)');
    src := replace(src, 'select a.id r1, b.id r2, a.owner_id u1, b.owner_id u2, a.played_on, a.course_name',
                        'select a.id r1, b.id r2, a.owner_id u1, b.owner_id u2, a.played_on, a.course_name, a.holes_played, a.counts_in_stats done1, b.counts_in_stats done2');
    src := replace(src, 'case when m->>''p1_hcp'' is null or m->>''p2_hcp'' is null then ''Uten hcp for begge: regnet brutto'' end)',
      'concat_ws(''. '', case when not (pr.done1 and pr.done2) and (m->>''remaining'')::int = 0 then format(''Ikke fullført: stilling etter %s hull'', m->>''n'') end,
                 case when m->>''p1_hcp'' is null or m->>''p2_hcp'' is null then ''Uten hcp for begge: regnet brutto'' end,
                 case when (m->>''tm_strokes'')::boolean then ''Slag som i TrackMan-spillet'' end))');
    execute src;
  end if;
end $$;

select public.detect_matches();
