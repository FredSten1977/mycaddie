-- My Caddie – import support
-- Single-owner app: rows written by trusted import paths (SQL editor / connector)
-- are attributed to the one app user. RLS still governs all client access.

create or replace function public.app_owner() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from auth.users order by created_at limit 1
$$;

-- canonical club list (idempotent)
create or replace function public.ensure_clubs() returns void
language plpgsql set search_path = public as $$
declare
  o uuid := public.app_owner();
  c record;
  a text;
begin
  if o is null then raise exception 'No app user exists yet (create one in Authentication > Users)'; end if;
  for c in select * from (values
    ('Driver','driver',1, array['driver','1wood','dr']),
    ('2 Wood','wood',2, array['2wood']),
    ('3 Wood','wood',3, array['3wood']),
    ('5 Wood','wood',4, array['5wood']),
    ('7 Wood','wood',5, array['7wood']),
    ('1 Iron','iron',6, array['1iron']),
    ('2 Iron','iron',7, array['2iron']),
    ('3 Hybrid','hybrid',8, array['3hybrid']),
    ('4 Hybrid','hybrid',9, array['4hybrid']),
    ('3 Iron','iron',10, array['3iron']),
    ('4 Iron','iron',11, array['4iron']),
    ('5 Iron','iron',12, array['5iron']),
    ('6 Iron','iron',13, array['6iron']),
    ('7 Iron','iron',14, array['7iron']),
    ('8 Iron','iron',15, array['8iron']),
    ('9 Iron','iron',16, array['9iron']),
    ('Pitching Wedge','wedge',17, array['pitchingwedge','pw']),
    ('50 Wedge','wedge',18, array['50wedge','gapwedge','gw']),
    ('52 Wedge','wedge',19, array['52wedge']),
    ('54 Wedge','wedge',20, array['54wedge']),
    ('Sand Wedge','wedge',21, array['sandwedge','sw']),
    ('56 Wedge','wedge',22, array['56wedge']),
    ('58 Wedge','wedge',23, array['58wedge']),
    ('Lob Wedge','wedge',24, array['lobwedge','lw']),
    ('60 Wedge','wedge',25, array['60wedge']),
    ('Putter','putter',99, array['putter'])
  ) as t(name, category, sort_order, aliases)
  loop
    insert into clubs(owner_id, name, category, sort_order) values (o, c.name, c.category, c.sort_order)
    on conflict (owner_id, name) do nothing;
    foreach a in array c.aliases || array[lower(regexp_replace(c.name, '[^A-Za-z0-9]', '', 'g'))] loop
      insert into club_aliases(owner_id, alias, club_id)
      select o, a, id from clubs where owner_id = o and name = c.name
      on conflict do nothing;
    end loop;
  end loop;
end $$;

-- club lookup from any raw spelling ('PitchingWedge', '7 Wood', 'PW' ...)
create or replace function public.club_for(p_raw text) returns uuid
language sql stable set search_path = public as $$
  select club_id from club_aliases
  where owner_id = public.app_owner()
    and alias = lower(regexp_replace(coalesce(p_raw,''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- Import one parsed file / activity.
-- p: {
--   "source":   {"type":"csv_upload","external_id":"<hash or id>","name":"file.csv","parser_version":"csv-v1","meta":{...}},
--   "sessions": [{"key":"k1","activity":"practice","trackman_kind":null,"surface":"mat",
--                 "started_at":"2026-09-23T03:28:14Z","external_id":"...","course_name":null}],
--   "shots":    [{"session":"k1","club":"PitchingWedge","shot_no":1,"shot_time":null,
--                 "club_speed_ms":..,"ball_speed_ms":.., ... ,"raw":{...}}]
-- }
-- Idempotent: sources, sessions and shots are all conflict-safe.
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
begin
  perform public.ensure_clubs();

  insert into sources(owner_id, source_type, external_id, name, parser_version, raw_meta)
  values (o, (p->'source'->>'type')::source_type, p->'source'->>'external_id', p->'source'->>'name',
          p->'source'->>'parser_version', coalesce(p->'source'->'meta','{}'))
  on conflict (owner_id, source_type, external_id) do update set name = excluded.name
  returning id into src_id;

  for s in select * from jsonb_array_elements(coalesce(p->'sessions','[]')) loop
    -- same physical session already present (from any source)? reuse it.
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

  select count(*) into n_shots_before from shots where owner_id = o;

  insert into shots(owner_id, session_id, source_id, club_id, club_raw, shot_no, shot_time, shot_key,
    club_speed_ms, ball_speed_ms, smash_factor, attack_angle, club_path, face_angle, face_to_path,
    swing_direction, dynamic_loft, spin_loft, launch_angle, launch_direction, spin_rate, spin_axis,
    carry_m, total_m, carry_side_m, total_side_m, carry_actual_m, carry_side_actual_m, curve_m,
    max_height_m, landing_angle, hang_time_s, low_point_cm, impact_height_mm, impact_offset_mm, raw)
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
    'shots_skipped', n_in - (n_shots_after - n_shots_before), 'unknown_clubs', unknown_clubs);
end $$;

-- these helpers are for trusted import paths only, never for API clients
revoke execute on function public.app_owner() from public, anon, authenticated;
revoke execute on function public.ensure_clubs() from public, anon, authenticated;
revoke execute on function public.club_for(text) from public, anon, authenticated;
revoke execute on function public.import_trackman(jsonb) from public, anon, authenticated;
