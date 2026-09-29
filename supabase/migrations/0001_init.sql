-- My Caddie – initial schema
-- Principles:
--   * Raw facts are append-only; derived values live in views.
--   * Every row is traceable to a source (sources table).
--   * Units are canonical SI: speeds m/s, distances m, angles deg, spin rpm.
--   * Single owner; Row Level Security restricts all rows to auth.uid().

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- enums
create type activity_type as enum (
  'practice',        -- SESSION / SHOT_ANALYSIS / RANGE_PRACTICE / VIRTUAL_RANGE / TrackPull practice CSV
  'course_play',     -- TrackMan COURSE_PLAY (simulator round)
  'map_my_bag',      -- TrackMan MAP_MY_BAG
  'test_game',       -- FIND_MY_DISTANCE, COMBINE_TEST, TARGET_PRACTICE, ...
  'other'
);
create type source_type as enum ('trackman_api', 'csv_upload', 'legacy_sheet', 'round_image', 'manual');
create type round_kind  as enum ('simulator', 'outdoor');
create type shot_kind   as enum ('full', 'partial', 'chip', 'putt', 'warmup', 'unknown');
create type shot_quality as enum ('ok', 'mishit', 'measurement_error', 'uncertain');

-- ---------------------------------------------------------------- helpers
create or replace function public.set_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

-- ---------------------------------------------------------------- sources
create table sources (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default auth.uid(),
  source_type     source_type not null,
  external_id     text not null,                 -- TrackMan activity id, Drive file id, file hash
  name            text,                          -- file name / activity label
  parser_version  text not null,
  raw_meta        jsonb not null default '{}',   -- e.g. {"hitting_surface":"Mat"}
  imported_at     timestamptz not null default now(),
  unique (owner_id, source_type, external_id)
);

-- ---------------------------------------------------------------- clubs & bag
create table clubs (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid(),
  name          text not null,                   -- canonical: 'Driver', '7 Iron', 'Pitching Wedge', '60 Wedge'
  category      text not null check (category in ('driver','wood','hybrid','iron','wedge','putter')),
  loft_deg      numeric,
  sort_order    int not null default 999,
  unique (owner_id, name)
);

create table club_aliases (
  owner_id  uuid not null default auth.uid(),
  alias     text not null,                       -- normalized: lower, no spaces ('pitchingwedge','7wood')
  club_id   uuid not null references clubs(id) on delete cascade,
  primary key (owner_id, alias)
);

create table bag_config (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid(),
  club_id     uuid not null references clubs(id),
  in_bag      boolean not null,
  valid_from  date not null,
  valid_to    date,                              -- null = current
  min_carry_hint_m numeric,                      -- soft hint only, never a hard filter
  max_carry_hint_m numeric,
  note        text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- sessions & shots
create table sessions (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default auth.uid(),
  source_id       uuid not null references sources(id),
  external_id     text,                          -- TrackMan Report ID / activity id
  activity        activity_type not null,
  trackman_kind   text,                          -- raw kind/typename from TrackMan
  surface         text,                          -- 'mat', 'grass', null = unknown
  started_at      timestamptz not null,
  course_name     text,                          -- course play only
  created_at      timestamptz not null default now(),
  unique (owner_id, activity, started_at, external_id)
);
create index on sessions (owner_id, started_at desc);

create table shots (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null default auth.uid(),
  session_id       uuid not null references sessions(id) on delete cascade,
  source_id        uuid not null references sources(id),
  club_id          uuid references clubs(id),
  club_raw         text,
  shot_no          int,
  shot_time        timestamptz,
  -- dedupe key: hash of physical measurements, independent of export format
  shot_key         text not null,
  -- measurements (SI)
  club_speed_ms    numeric, ball_speed_ms numeric, smash_factor numeric,
  attack_angle     numeric, club_path numeric, face_angle numeric, face_to_path numeric,
  swing_direction  numeric, dynamic_loft numeric, spin_loft numeric,
  launch_angle     numeric, launch_direction numeric, spin_rate numeric, spin_axis numeric,
  carry_m          numeric, total_m numeric, carry_side_m numeric, total_side_m numeric,
  carry_actual_m   numeric, carry_side_actual_m numeric, curve_m numeric,
  max_height_m     numeric, landing_angle numeric, hang_time_s numeric,
  low_point_cm     numeric, impact_height_mm numeric, impact_offset_mm numeric,
  -- course-play context (null for practice)
  round_hole_id    uuid,                         -- fk added after round_holes exists
  launch_lie       text, final_lie text,
  dist_to_pin_before_m numeric, dist_to_pin_after_m numeric,
  shot_result      text,
  raw              jsonb not null default '{}',  -- original row, untouched
  created_at       timestamptz not null default now(),
  unique (owner_id, shot_key)
);
create index on shots (owner_id, club_id);
create index on shots (session_id);

-- ---------------------------------------------------------------- classification (versioned, overridable)
create table shot_classifications (
  shot_id            uuid not null references shots(id) on delete cascade,
  classifier_version text not null,
  owner_id           uuid not null default auth.uid(),
  kind               shot_kind not null,
  quality            shot_quality not null,
  reason             text,
  created_at         timestamptz not null default now(),
  primary key (shot_id, classifier_version)
);

create table shot_overrides (                    -- manual decision always wins
  shot_id     uuid primary key references shots(id) on delete cascade,
  owner_id    uuid not null default auth.uid(),
  kind        shot_kind,
  quality     shot_quality,
  exclude     boolean not null default false,
  note        text,
  updated_at  timestamptz not null default now()
);
create trigger shot_overrides_upd before update on shot_overrides for each row execute function set_updated_at();

-- ---------------------------------------------------------------- rounds
create table rounds (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null default auth.uid(),
  kind             round_kind not null,
  source_id        uuid not null references sources(id),
  session_id       uuid references sessions(id),  -- simulator rounds link to course_play session
  played_on        date not null,
  course_name      text not null,
  tee_name         text,
  holes_played     int not null check (holes_played between 1 and 18),
  par              int,
  strokes          int,
  stableford_points int,
  fir_hit          int, fir_possible int,
  gir_hit          int, gir_possible int,
  scrambling_made  int, scrambling_possible int,
  putts            int,
  avg_drive_m      numeric, longest_drive_m numeric,
  conditions       jsonb not null default '{}',  -- stimp, wind, firmness
  verified         boolean not null default false,
  comment          text,
  content_key      text not null,                 -- kind|date|course|strokes → duplicate guard
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (owner_id, content_key)
);
create trigger rounds_upd before update on rounds for each row execute function set_updated_at();

create table round_holes (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null default auth.uid(),
  round_id         uuid not null references rounds(id) on delete cascade,
  hole_no          int not null,
  par              int, length_m numeric, stroke_index int,
  strokes          int, putts int,
  fairway_hit      boolean, gir boolean, stableford int,
  unique (round_id, hole_no)
);
alter table shots add constraint shots_round_hole_fk foreign key (round_hole_id) references round_holes(id);

create table round_images (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null default auth.uid(),
  round_id      uuid references rounds(id),
  source_id     uuid not null references sources(id),
  storage_path  text not null,
  ocr_text      text,
  extracted     jsonb,                           -- values as read, before user confirmation
  extractor     text,                            -- 'vision+rules v1', 'gemini-2.x', ...
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------- audit & ops
create table manual_corrections (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null default auth.uid(),
  table_name  text not null,
  row_id      uuid not null,
  field       text not null,
  old_value   jsonb,
  new_value   jsonb,
  changed_at  timestamptz not null default now()
);

create table sync_runs (
  id           bigint generated always as identity primary key,
  owner_id     uuid not null default auth.uid(),
  channel      text not null,                   -- 'extension', 'csv_upload', 'image'
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running','ok','partial','error')),
  new_sessions int not null default 0,
  new_shots    int not null default 0,
  skipped_dupes int not null default 0,
  message      text
);

-- ---------------------------------------------------------------- RLS: owner only
do $$
declare t text;
begin
  foreach t in array array['sources','clubs','club_aliases','bag_config','sessions','shots',
    'shot_classifications','shot_overrides','rounds','round_holes','round_images',
    'manual_corrections','sync_runs']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy owner_all on %I for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()))', t);
  end loop;
end $$;
