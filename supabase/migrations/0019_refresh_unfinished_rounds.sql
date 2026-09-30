-- Rounds synced while they were still being played (e.g. mid-round) were stored with the holes played so far
-- and never refreshed, because the activity was then "known". Now:
-- 1) an unfinished round from the last 7 days is not reported as known, so the extension fetches it again;
-- 2) importing a known round updates its score, holes and hole-by-hole data (not only the metadata).

do $$
declare src text;
begin
  src := pg_get_functiondef('public.import_trackman(jsonb)'::regprocedure);
  if position('refresh score and holes' in src) = 0 then
    src := replace(src,
E'      -- known round: refresh metadata only (TrackMan handicap, tee)\n      update rounds set conditions = coalesce(conditions, ''{}'') || coalesce(r->''conditions'', ''{}''),\n                        tee_name = coalesce(r->>''tee_name'', tee_name)\n       where id = rid;\n      update round_holes rh set hcp_strokes = (h->>''hcp_strokes'')::int\n        from jsonb_array_elements(coalesce(r->''holes'', ''[]'')) h\n       where rh.round_id = rid and rh.hole_no = (h->>''hole_no'')::int;',
E'      -- known round: refresh score and holes (the round may have been synced while it was being played) and metadata\n      update rounds set conditions = coalesce(conditions, ''{}'') || coalesce(r->''conditions'', ''{}''),\n                        tee_name = coalesce(r->>''tee_name'', tee_name),\n                        holes_played = greatest(1, least(18, coalesce((r->>''holes_played'')::int, holes_played))),\n                        par = coalesce((r->>''par'')::int, par), strokes = coalesce((r->>''strokes'')::int, strokes),\n                        stableford_points = coalesce((r->>''stableford_points'')::int, stableford_points),\n                        fir_hit = coalesce((r->>''fir_hit'')::int, fir_hit), fir_possible = coalesce((r->>''fir_possible'')::int, fir_possible),\n                        gir_hit = coalesce((r->>''gir_hit'')::int, gir_hit), gir_possible = coalesce((r->>''gir_possible'')::int, gir_possible),\n                        scrambling_made = coalesce((r->>''scrambling_made'')::int, scrambling_made),\n                        scrambling_possible = coalesce((r->>''scrambling_possible'')::int, scrambling_possible),\n                        putts = coalesce((r->>''putts'')::int, putts),\n                        avg_drive_m = coalesce((r->>''avg_drive_m'')::numeric, avg_drive_m), longest_drive_m = coalesce((r->>''longest_drive_m'')::numeric, longest_drive_m),\n                        updated_at = now()\n       where id = rid;\n      insert into round_holes(owner_id, round_id, hole_no, par, length_m, stroke_index, strokes, putts, fairway_hit, gir, stableford, hcp_strokes)\n      select o, rid, (h->>''hole_no'')::int, (h->>''par'')::int, (h->>''length_m'')::numeric, (h->>''stroke_index'')::int,\n             (h->>''strokes'')::int, (h->>''putts'')::int, (h->>''fairway_hit'')::boolean, (h->>''gir'')::boolean, (h->>''stableford'')::int, (h->>''hcp_strokes'')::int\n      from jsonb_array_elements(coalesce(r->''holes'', ''[]'')) h\n      on conflict (round_id, hole_no) do update set par = excluded.par, length_m = excluded.length_m, stroke_index = excluded.stroke_index,\n        strokes = excluded.strokes, putts = excluded.putts, fairway_hit = excluded.fairway_hit, gir = excluded.gir,\n        stableford = excluded.stableford, hcp_strokes = excluded.hcp_strokes;');
    if position('refresh score and holes' in src) = 0 then raise exception 'import_trackman patch did not apply'; end if;
    execute src;
  end if;
end $$;

create or replace function public.sync_known_activities() returns setof text
language sql stable security definer set search_path = public as $$
  select s.external_id from sources s
  where s.owner_id = public.current_owner() and s.source_type = 'trackman_api'
    and auth.uid() = public.current_owner()
    -- Wednesday rounds (matchplay) without TrackMan handicap data are fetched again once
    and not exists (select 1 from rounds r where r.source_id = s.id and r.kind = 'simulator'
                    and r.holes_played >= 9 and extract(isodow from r.played_on) = 3
                    and not (coalesce(r.conditions, '{}') ? 'tm_meta_v'))
    -- rounds that were synced before they were finished are fetched again for a week
    and not exists (select 1 from rounds r where r.source_id = s.id and r.kind = 'simulator'
                    and r.played_on >= current_date - 7
                    and coalesce(r.conditions->>'isCompleted', 'true') = 'false')
$$;
