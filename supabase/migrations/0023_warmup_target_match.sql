-- TrackMan's stroke timestamps have gained precision since older imports (ms → 100 ns), so the
-- target back-fill matches shots within 50 ms on the same club instead of on the exact time.
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
  where x.session_id = sid and x.owner_id = o
    and x.shot_time between (j.v->>'shot_time')::timestamptz - interval '50 milliseconds' and (j.v->>'shot_time')::timestamptz + interval '50 milliseconds'
    and coalesce(x.raw->>'club', x.club_raw) is not distinct from j.v->>'club';
  get diagnostics n = row_count;
  -- strokes TrackMan no longer returns: mark as checked (only when the session matched)
  if n > 0 then
    update shots set raw = raw || '{"target": null}'::jsonb where session_id = sid and owner_id = o and not (raw ? 'target');
  end if;
  perform public.detect_warmups();
  return jsonb_build_object('updated', n);
end $$;
-- shots that were only marked (no match) are fetched again
update shots set raw = raw - 'target' where raw ? 'target' and raw->'target' = 'null'::jsonb and not (raw ? 'tags');
