-- My Caddie – TrackMan sync support
-- * import_trackman now also accepts an optional "round" (course play scorecard) and
--   per-shot course context (hole_no, lies, distance to pin).
-- * Legacy simulator rounds are never deleted; they are marked superseded when the
--   TrackMan scorecard for the same day arrives.
-- * sync_import / sync_known_activities: the only entry points the browser extension
--   may call (as the signed-in owner, through the public API).

alter table rounds add column superseded_by uuid references rounds(id);
alter table shots  add column hole_no int;

create or replace function public.import_trackman(p jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare
  o uuid := public.app_owner();
  src_id uuid;
  s jsonb;
  sess_map jsonb := '{}';
  sid uuid;
  n_sess_new int := 0;
  n_shots_before int;
  n_shots_after int;
  n_in int := coalesce(jsonb_array_length(p->'shots'), 0);
  unknown_clubs text[];
  r jsonb := p->'round';
  rid uuid;
  round_new boolean := false;
  n_superseded int := 0;
begin
  perform public.ensure_clubs();

  insert into sources(owner_id, source_type, external_id, name, parser_version, raw_meta)
  values (o, (p->'source'->>'type')::source_type, p->'source'->>'external_id', p->'source'->>'name',
          p->'source'->>'parser_version', coalesce(p->'source'->'meta','{}'))
  on conflict (owner_id, source_type, external_id) do update set name = excluded.name
  returning id into src_id;

  for s in select * from jsonb_array_elements(coalesce(p->'sessions','[]')) loop
    select id into sid from sessions
     where owner_id = o
       and activity = (s->>'activity')::activity_type
       and abs(extract(epoch from started_at - (s->>'started_at')::timestamptz)) < 1
       and (external_id is not distinct from s->>'external_id' or external_id is null or s->>'external_id' is null)
     limit 1;
    if sid is null then
      insert into sessions(owner_id, source_id, external_id, activity, trackman_kind, surface, started_at, course_name)
      values (o, src_id, s->>'external_id', (s->>'activity')::activity_type, s->>'trackman_kind',
              s->>'surface', (s->>'started_at')::timestamptz, s->>'course_name')
      returning id into sid;
      n_sess_new := n_sess_new + 1;
    end if;
    sess_map := sess_map || jsonb_build_object(s->>'key', sid);
  end loop;

  -- optional round (course play scorecard)
  if r is not null then
    select id into rid from rounds where owner_id = o and content_key = r->>'content_key';
    if rid is null then
      insert into rounds(owner_id, kind, source_id, session_id, played_on, course_name, tee_name, holes_played, par,
                         strokes, stableford_points, fir_hit, fir_possible, gir_hit, gir_possible,
                         scrambling_made, scrambling_possible, putts, avg_drive_m, longest_drive_m,
                         conditions, verified, content_key)
      values (o, 'simulator', src_id, (sess_map->>(r->>'session'))::uuid, (r->>'played_on')::date,
              coalesce(r->>'course_name','Ukjent bane'), r->>'tee_name', greatest(1, least(18, coalesce((r->>'holes_played')::int, 18))),
              (r->>'par')::int, (r->>'strokes')::int, (r->>'stableford_points')::int,
              (r->>'fir_hit')::int, (r->>'fir_possible')::int, (r->>'gir_hit')::int, (r->>'gir_possible')::int,
              (r->>'scrambling_made')::int, (r->>'scrambling_possible')::int, (r->>'putts')::int,
              (r->>'avg_drive_m')::numeric, (r->>'longest_drive_m')::numeric,
              coalesce(r->'conditions','{}'), true, r->>'content_key')
      returning id into rid;
      round_new := true;

      insert into round_holes(owner_id, round_id, hole_no, par, length_m, stroke_index, strokes, putts, fairway_hit, gir, stableford)
      select o, rid, (h->>'hole_no')::int, (h->>'par')::int, (h->>'length_m')::numeric, (h->>'stroke_index')::int,
             (h->>'strokes')::int, (h->>'putts')::int, (h->>'fairway_hit')::boolean, (h->>'gir')::boolean, (h->>'stableford')::int
      from jsonb_array_elements(coalesce(r->'holes','[]')) h
      on conflict (round_id, hole_no) do nothing;

      -- legacy OCR simulator round(s) for the same day and score are superseded, never deleted
      update rounds set superseded_by = rid
       where owner_id = o and kind = 'simulator' and id <> rid and superseded_by is null
         and source_id in (select id from sources where owner_id = o and source_type = 'legacy_sheet')
         and played_on = (r->>'played_on')::date
         and (strokes is null or strokes = (r->>'strokes')::int);
      get diagnostics n_superseded = row_count;
    end if;
  end if;

  select count(*) into n_shots_before from shots where owner_id = o;

  insert into shots(owner_id, session_id, source_id, club_id, club_raw, shot_no, shot_time, shot_key,
    club_speed_ms, ball_speed_ms, smash_factor, attack_angle, club_path, face_angle, face_to_path,
    swing_direction, dynamic_loft, spin_loft, launch_angle, launch_direction, spin_rate, spin_axis,
    carry_m, total_m, carry_side_m, total_side_m, carry_actual_m, carry_side_actual_m, curve_m,
    max_height_m, landing_angle, hang_time_s, low_point_cm, impact_height_mm, impact_offset_mm,
    hole_no, round_hole_id, launch_lie, final_lie, dist_to_pin_before_m, dist_to_pin_after_m, shot_result, raw)
  select o,
    (sess_map->>(x->>'session'))::uuid,
    src_id,
    public.club_for(x->>'club'),
    x->>'club',
    (x->>'shot_no')::int,
    (x->>'shot_time')::timestamptz,
    md5(concat_ws('|', sess_map->>(x->>'session'),
                  lower(regexp_replace(coalesce(x->>'club',''), '[^A-Za-z0-9]', '', 'g')),
                  x->>'shot_no',
                  round((x->>'carry_m')::numeric, 1),
                  round((x->>'ball_speed_ms')::numeric, 1))),
    (x->>'club_speed_ms')::numeric, (x->>'ball_speed_ms')::numeric, (x->>'smash_factor')::numeric,
    (x->>'attack_angle')::numeric, (x->>'club_path')::numeric, (x->>'face_angle')::numeric,
    (x->>'face_to_path')::numeric, (x->>'swing_direction')::numeric, (x->>'dynamic_loft')::numeric,
    (x->>'spin_loft')::numeric, (x->>'launch_angle')::numeric, (x->>'launch_direction')::numeric,
    (x->>'spin_rate')::numeric, (x->>'spin_axis')::numeric, (x->>'carry_m')::numeric,
    (x->>'total_m')::numeric, (x->>'carry_side_m')::numeric, (x->>'total_side_m')::numeric,
    (x->>'carry_actual_m')::numeric, (x->>'carry_side_actual_m')::numeric, (x->>'curve_m')::numeric,
    (x->>'max_height_m')::numeric, (x->>'landing_angle')::numeric, (x->>'hang_time_s')::numeric,
    (x->>'low_point_cm')::numeric, (x->>'impact_height_mm')::numeric, (x->>'impact_offset_mm')::numeric,
    (x->>'hole_no')::int,
    (select rh.id from round_holes rh where rh.round_id = rid and rh.hole_no = (x->>'hole_no')::int),
    x->>'launch_lie', x->>'final_lie',
    (x->>'dist_to_pin_before_m')::numeric, (x->>'dist_to_pin_after_m')::numeric, x->>'shot_result',
    coalesce(x->'raw', '{}')
  from jsonb_array_elements(coalesce(p->'shots','[]')) x
  on conflict (owner_id, shot_key) do nothing;

  select count(*) into n_shots_after from shots where owner_id = o;

  select array_agg(distinct x->>'club') into unknown_clubs
  from jsonb_array_elements(coalesce(p->'shots','[]')) x
  where public.club_for(x->>'club') is null;

  insert into sync_runs(owner_id, channel, finished_at, status, new_sessions, new_shots, skipped_dupes, message)
  values (o, coalesce(p->>'channel','csv_upload'), now(), 'ok', n_sess_new, n_shots_after - n_shots_before,
          n_in - (n_shots_after - n_shots_before), p->'source'->>'name');

  return jsonb_build_object('source', p->'source'->>'name', 'sessions_new', n_sess_new,
    'shots_in', n_in, 'shots_new', n_shots_after - n_shots_before,
    'shots_skipped', n_in - (n_shots_after - n_shots_before), 'unknown_clubs', unknown_clubs,
    'round_new', round_new, 'legacy_rounds_superseded', n_superseded);
end $$;
revoke execute on function public.import_trackman(jsonb) from public, anon, authenticated;

-- ---- entry points for the browser extension (signed-in owner only)
create or replace function public.sync_import(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or auth.uid() <> public.app_owner() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if (p->'source'->>'type') <> 'trackman_api' then
    raise exception 'sync_import only accepts trackman_api sources' using errcode = '22023';
  end if;
  return public.import_trackman(p || jsonb_build_object('channel', 'extension'));
end $$;

create or replace function public.sync_known_activities() returns setof text
language sql stable security definer set search_path = public as $$
  select s.external_id from sources s
  where s.owner_id = public.app_owner() and s.source_type = 'trackman_api'
    and auth.uid() = public.app_owner()
$$;

revoke execute on function public.sync_import(jsonb) from public, anon;
revoke execute on function public.sync_known_activities() from public, anon;
grant execute on function public.sync_import(jsonb) to authenticated;
grant execute on function public.sync_known_activities() to authenticated;
