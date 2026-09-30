-- Handicap from TrackMan: the scorecard carries each player's hcp index, course handicap and strokes per hole.
-- Stored on the round (conditions.tm_*) and per hole (round_holes.hcp_strokes). Existing rounds are refreshed
-- by the extension (0.3.0): rounds without tm_meta_v are no longer reported as "known", so they are fetched again
-- and only their metadata is updated (shots are de-duplicated as before).

alter table public.round_holes add column if not exists hcp_strokes int;

do $$
declare src text;
begin
  src := pg_get_functiondef('public.import_trackman(jsonb)'::regprocedure);
  if position('round_meta' in src) = 0 then
    src := replace(src, E'declare\n  o uuid', E'declare\n  round_meta boolean := false;\n  o uuid');
    src := replace(src,
      'insert into round_holes(owner_id, round_id, hole_no, par, length_m, stroke_index, strokes, putts, fairway_hit, gir, stableford)',
      'insert into round_holes(owner_id, round_id, hole_no, par, length_m, stroke_index, strokes, putts, fairway_hit, gir, stableford, hcp_strokes)');
    src := replace(src,
      '(h->>''putts'')::int, (h->>''fairway_hit'')::boolean, (h->>''gir'')::boolean, (h->>''stableford'')::int',
      '(h->>''putts'')::int, (h->>''fairway_hit'')::boolean, (h->>''gir'')::boolean, (h->>''stableford'')::int, (h->>''hcp_strokes'')::int');
    src := replace(src,
      E'      get diagnostics n_superseded = row_count;\n    end if;',
      E'      get diagnostics n_superseded = row_count;\n    else\n      -- known round: refresh metadata only (TrackMan handicap, tee)\n      update rounds set conditions = coalesce(conditions, ''{}'') || coalesce(r->''conditions'', ''{}''),\n                        tee_name = coalesce(r->>''tee_name'', tee_name)\n       where id = rid;\n      update round_holes rh set hcp_strokes = (h->>''hcp_strokes'')::int\n        from jsonb_array_elements(coalesce(r->''holes'', ''[]'')) h\n       where rh.round_id = rid and rh.hole_no = (h->>''hole_no'')::int;\n      round_meta := r->''conditions'' ? ''tm_meta_v'';\n    end if;');
    src := replace(src, E'''round_new'', round_new,', E'''round_new'', round_new, ''round_meta'', round_meta,');
    execute src;
  end if;

  src := pg_get_functiondef('public.sync_import(jsonb)'::regprocedure);
  src := replace(src, 'if coalesce((res->>''round_new'')::boolean, false) then perform public.detect_matches(); end if;',
                      'if coalesce((res->>''round_new'')::boolean, false) or coalesce((res->>''round_meta'')::boolean, false) then perform public.detect_matches(); end if;');
  execute src;
end $$;

-- Activities are "known" (skipped by the extension) unless their round still lacks TrackMan handicap data
create or replace function public.sync_known_activities() returns setof text
language sql stable security definer set search_path = public as $$
  select s.external_id from sources s
  where s.owner_id = public.current_owner() and s.source_type = 'trackman_api'
    and auth.uid() = public.current_owner()
    -- Wednesday rounds (matchplay) without TrackMan handicap data are fetched again once
    and not exists (select 1 from rounds r where r.source_id = s.id and r.kind = 'simulator'
                    and r.holes_played >= 9 and extract(isodow from r.played_on) = 3
                    and not (coalesce(r.conditions, '{}') ? 'tm_meta_v'))
$$;

-- Matchplay: TrackMan's own numbers first (hcp index and course handicap on the scorecard), then the profile.
do $$
declare src text;
begin
  src := pg_get_functiondef('public.compute_match(uuid,uuid)'::regprocedure);
  src := replace(src, 'hi1 := public.hcp_on(r1.owner_id, r1.played_on);',
                      'hi1 := coalesce((r1.conditions->>''tm_hcp'')::numeric, public.hcp_on(r1.owner_id, r1.played_on));');
  src := replace(src, 'hi2 := public.hcp_on(r2.owner_id, r2.played_on);',
                      'hi2 := coalesce((r2.conditions->>''tm_hcp'')::numeric, public.hcp_on(r2.owner_id, r2.played_on));');
  src := replace(src, 'ch1 := public.course_hcp(hi1, r1.course_name, r1.tee_name);',
                      'ch1 := coalesce(round((r1.conditions->>''tm_course_hcp'')::numeric)::int, public.course_hcp(hi1, r1.course_name, r1.tee_name));');
  src := replace(src, 'ch2 := public.course_hcp(hi2, r2.course_name, r2.tee_name);',
                      'ch2 := coalesce(round((r2.conditions->>''tm_course_hcp'')::numeric)::int, public.course_hcp(hi2, r2.course_name, r2.tee_name));');
  execute src;
end $$;
