-- My Caddie – app v1 backend
-- 1) Club correction: the player can say which club a shot was really hit with.
--    The raw shot (shots.club_id) is never changed; the correction lives in shot_overrides.club_id.
-- 2) TrackMan course catalog (public data) and course ratings (1–5 stars).
-- 3) RPCs for the app: review_queue, set_shot_club, reclassify, course_overview.

-- ---------------------------------------------------------------- 1. club correction
alter table public.shot_overrides add column if not exists club_id uuid references public.clubs(id);

-- v_shots: club_id is now the effective club (correction > TrackMan tag). orig_club_id keeps the tag.
create or replace view public.v_shots with (security_invoker = true) as
select sh.id, sh.owner_id, sh.session_id, sh.source_id,
       coalesce(ov.club_id, sh.club_id) as club_id,
       sh.club_raw, sh.shot_no, sh.shot_time, sh.shot_key,
       sh.club_speed_ms, sh.ball_speed_ms, sh.smash_factor, sh.attack_angle, sh.club_path, sh.face_angle,
       sh.face_to_path, sh.swing_direction, sh.dynamic_loft, sh.spin_loft, sh.launch_angle, sh.launch_direction,
       sh.spin_rate, sh.spin_axis, sh.carry_m, sh.total_m, sh.carry_side_m, sh.total_side_m, sh.carry_actual_m,
       sh.carry_side_actual_m, sh.curve_m, sh.max_height_m, sh.landing_angle, sh.hang_time_s, sh.low_point_cm,
       sh.impact_height_mm, sh.impact_offset_mm, sh.round_hole_id, sh.launch_lie, sh.final_lie,
       sh.dist_to_pin_before_m, sh.dist_to_pin_after_m, sh.shot_result, sh.raw, sh.created_at, sh.hole_no,
       se.activity, se.started_at, se.course_name as session_course,
       c.name as club, c.category as club_category, c.sort_order as club_order,
       coalesce(ov.kind, sc.kind) as kind,
       coalesce(ov.quality, sc.quality) as quality,
       coalesce(ov.exclude, false) as excluded,
       sc.reason, (ov.shot_id is not null) as overridden,
       sh.club_id as orig_club_id,
       (ov.club_id is not null) as club_reviewed
from shots sh
join sessions se on se.id = sh.session_id
left join shot_overrides ov on ov.shot_id = sh.id
left join clubs c on c.id = coalesce(ov.club_id, sh.club_id)
left join shot_classifications sc on sc.shot_id = sh.id and sc.classifier_version = 'v1';

-- Classifier: uses the corrected club; a reviewed club is never flagged as "possible wrong club".
create or replace function public.classify_shots_v1() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o uuid := public.app_owner();
  n int;
begin
  delete from shot_classifications where owner_id = o and classifier_version = 'v1';

  with base as (
    select sh.id, coalesce(ov.club_id, sh.club_id) as club_id, (ov.club_id is not null) as reviewed,
           c.category, se.activity, sh.shot_result, sh.launch_lie,
           sh.ball_speed_ms bs, sh.carry_m carry, sh.smash_factor smash, sh.launch_angle la, sh.spin_rate spin,
           sh.dist_to_pin_before_m pin, sh.dynamic_loft dl
    from shots sh
    join sessions se on se.id = sh.session_id
    left join shot_overrides ov on ov.shot_id = sh.id
    left join clubs c on c.id = coalesce(ov.club_id, sh.club_id)
    where sh.owner_id = o
  ),
  s1 as (
    select b.*,
      case
        when b.category = 'putter' or b.shot_result = 'AutoPutt' or b.launch_lie = 'Green' then 'putt'
        when b.shot_result in ('Gimme','Drop','Pickup') then 'noswing'
        when b.bs is null or b.carry is null or b.carry <= 1
          or b.la not between -10 and 75 or b.spin > 14000 or (b.spin < 300 and b.carry > 20)
          or b.smash > 1.62 then 'error'
        else 'swing'
      end as stage
    from base b
  ),
  ref as (
    select club_id, percentile_cont(.8) within group (order by bs) as ref_bs
    from s1 where stage = 'swing' and club_id is not null
    group by club_id
  ),
  ref2 as (
    select s.club_id, r.ref_bs,
      percentile_cont(.5) within group (order by s.carry) as ref_carry,
      percentile_cont(.5) within group (order by s.smash) as ref_smash,
      percentile_cont(.5) within group (order by s.la) as ref_la,
      coalesce(
        percentile_cont(.5) within group (order by s.dl) filter (where s.activity = 'map_my_bag'),
        percentile_cont(.5) within group (order by s.dl)) as ref_dl
    from s1 s join ref r using (club_id)
    where s.stage = 'swing' and s.bs >= 0.85 * r.ref_bs
    group by s.club_id, r.ref_bs
  ),
  cls as (
    select s.id, s.stage, s.category, s.carry, s.pin,
           r.ref_bs,
           (s.bs / nullif(r.ref_bs,0)) as bs_ratio,
           (s.carry / nullif(r.ref_carry,0)) as carry_ratio,
           (s.smash < 0.92 * r.ref_smash or abs(s.la - r.ref_la) > 7) as poor_strike,
           (s.pin is not null and s.pin >= 0.9 * r.ref_carry) as full_needed,
           (s.pin is not null and s.pin < 0.85 * r.ref_carry) as short_needed,
           (not s.reviewed and (
              s.bs > 1.2 * r.ref_bs or (s.bs > 1.05 * r.ref_bs and s.la < r.ref_la - 12)
              or (s.dl is not null and r.ref_dl is not null and s.dl < r.ref_dl - 7 and s.carry > r.ref_carry))) as wrong_club
    from s1 s left join ref2 r on r.club_id = s.club_id
  )
  insert into shot_classifications(shot_id, classifier_version, owner_id, kind, quality, reason)
  select id, 'v1', o,
    (case
      when stage = 'putt' then 'putt'
      when stage in ('noswing','error') then 'unknown'
      when ref_bs is null then 'unknown'
      when carry < 30 or bs_ratio < 0.5 then 'chip'
      when short_needed then (case when bs_ratio < 0.85 or carry_ratio < 0.85 then 'partial' else 'full' end)
      when bs_ratio >= 0.85 then 'full'
      when full_needed then 'full'
      when category = 'wedge' then 'partial'
      when poor_strike and carry_ratio < 0.8 then 'full'
      else 'partial'
    end)::shot_kind,
    (case
      when stage = 'error' then 'measurement_error'
      when stage in ('putt') then 'ok'
      when stage = 'noswing' or ref_bs is null then 'uncertain'
      when carry < 30 or bs_ratio < 0.5 then 'ok'
      when wrong_club then 'uncertain'
      when short_needed and (bs_ratio < 0.85 or carry_ratio < 0.85) then 'ok'
      when (bs_ratio >= 0.85 or full_needed or (category <> 'wedge' and poor_strike and carry_ratio < 0.8))
           and carry_ratio < 0.8 and (poor_strike or bs_ratio < 0.85) then 'mishit'
      else 'ok'
    end)::shot_quality,
    concat_ws('; ',
      case stage when 'putt' then 'putt' when 'noswing' then 'ikke et slag' when 'error' then 'målefeil' end,
      case when ref_bs is not null and stage = 'swing' then
        format('fart %s%% · carry %s%% av normal', round(bs_ratio*100), round(carry_ratio*100)) end,
      case when stage = 'swing' and pin is not null then format('%s m til flagg', round(pin)) end,
      case when stage = 'swing' and poor_strike then 'dårlig treff' end,
      case when stage = 'swing' and wrong_club then 'mulig feil kølle' end)
  from cls;

  get diagnostics n = row_count;
  return jsonb_build_object('classified', n);
end $$;
revoke execute on function public.classify_shots_v1() from public, anon, authenticated;

-- Reference values per club for suggesting the real club (good full shots, Map My Bag loft first)
create or replace function public.club_refs()
returns table (club_id uuid, ref_dl numeric, ref_bs numeric, ref_carry numeric, n bigint)
language sql stable security invoker set search_path = public as $$
  select v.club_id,
    coalesce(percentile_cont(.5) within group (order by v.dynamic_loft) filter (where v.activity = 'map_my_bag'),
             percentile_cont(.5) within group (order by v.dynamic_loft))::numeric,
    percentile_cont(.5) within group (order by v.ball_speed_ms)::numeric,
    percentile_cont(.5) within group (order by v.carry_m)::numeric,
    count(*)
  from v_shots v
  where v.kind = 'full' and v.quality = 'ok' and not v.excluded and v.club_id is not null
    and v.club_category is distinct from 'putter'
  group by v.club_id
  having count(*) >= 10;
$$;
grant execute on function public.club_refs() to authenticated;

-- Shots flagged "possible wrong club" that the player has not reviewed, with suggestions
-- (only clubs that were in the bag on that date).
create or replace function public.review_queue(p_limit int default 100)
returns table (
  shot_id uuid, started_at timestamptz, activity activity_type, course text, hole_no int, shot_no int,
  tagged_club text, tagged_club_id uuid, carry_m numeric, ball_speed_ms numeric, dynamic_loft numeric,
  launch_angle numeric, dist_to_pin_m numeric, suggestions jsonb
) language sql stable security invoker set search_path = public as $$
  with q as (
    select v.* from v_shots v
    where v.reason like '%mulig feil kølle%' and not v.club_reviewed and not v.excluded
    order by v.started_at desc, v.shot_no
    limit p_limit
  ), refs as (select * from public.club_refs()),
  cand as (
    select q.id as shot_id, c.id as club_id, c.name,
      (case when q.dynamic_loft is not null and r.ref_dl is not null then abs(q.dynamic_loft - r.ref_dl) / 2.5 else 1 end)
      + abs(q.ball_speed_ms - r.ref_bs) / greatest(0.04 * r.ref_bs, 1) as dist
    from q
    join refs r on true
    join clubs c on c.id = r.club_id
    where exists (select 1 from bag_config b where b.club_id = c.id and b.in_bag
                  and b.valid_from <= q.started_at::date and (b.valid_to is null or b.valid_to >= q.started_at::date))
  ), ranked as (
    select shot_id, club_id, name, dist, row_number() over (partition by shot_id order by dist) as rk,
           exp(-dist) / sum(exp(-dist)) over (partition by shot_id) as p
    from cand
  )
  select q.id, q.started_at, q.activity, q.session_course, q.hole_no, q.shot_no,
    q.club, q.orig_club_id, q.carry_m, q.ball_speed_ms, q.dynamic_loft, q.launch_angle, q.dist_to_pin_before_m,
    coalesce((select jsonb_agg(jsonb_build_object('club_id', r.club_id, 'club', r.name, 'p', round(r.p::numeric, 2)) order by r.rk)
              from ranked r where r.shot_id = q.id and r.rk <= 3 and r.club_id <> q.orig_club_id), '[]'::jsonb)
  from q
  order by q.started_at desc, q.shot_no;
$$;
grant execute on function public.review_queue(int) to authenticated;

-- Set the real club for a shot (p_club = original club means "the tag was right"),
-- or exclude it. Every change is logged in manual_corrections. Raw data is never touched.
create or replace function public.set_shot_club(p_shot uuid, p_club uuid default null, p_exclude boolean default false,
                                                p_reclassify boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  o uuid := public.app_owner();
  old jsonb;
begin
  if auth.uid() is null or auth.uid() <> o then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from shots where id = p_shot and owner_id = o) then raise exception 'unknown shot'; end if;
  if p_club is not null and not exists (select 1 from clubs where id = p_club and owner_id = o) then
    raise exception 'unknown club';
  end if;

  select to_jsonb(ov) into old from shot_overrides ov where ov.shot_id = p_shot;

  insert into shot_overrides(shot_id, owner_id, club_id, exclude, note, updated_at)
  values (p_shot, o, p_club, coalesce(p_exclude, false), 'app: kølle-gjennomgang', now())
  on conflict (shot_id) do update
    set club_id = excluded.club_id, exclude = excluded.exclude, note = excluded.note, updated_at = now();

  insert into manual_corrections(owner_id, table_name, row_id, field, old_value, new_value)
  values (o, 'shot_overrides', p_shot, case when p_exclude then 'exclude' else 'club_id' end, old,
          jsonb_build_object('club_id', p_club, 'exclude', coalesce(p_exclude, false)));

  if p_reclassify then perform public.classify_shots_v1(); end if;
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.set_shot_club(uuid, uuid, boolean, boolean) from public, anon;
grant execute on function public.set_shot_club(uuid, uuid, boolean, boolean) to authenticated;

create or replace function public.reclassify() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or auth.uid() <> public.app_owner() then raise exception 'not allowed' using errcode = '42501'; end if;
  return public.classify_shots_v1();
end $$;
revoke execute on function public.reclassify() from public, anon;
grant execute on function public.reclassify() to authenticated;

-- ---------------------------------------------------------------- 2. courses
create or replace function public.name_key(t text) returns text
language sql immutable set search_path = public as $$ select lower(regexp_replace(coalesce(t, ''), '[^[:alnum:]]', '', 'g')) $$;

-- TrackMan course catalog (public, same for everyone). Written only by the edge function (service role).
create table if not exists public.tm_courses (
  id text primary key,                 -- TrackMan node id
  identifier text,
  name text not null,
  name_key text generated always as (public.name_key(name)) stored,
  location text,
  lat double precision, lon double precision,
  difficulty int,
  holes int,
  tags text[] not null default '{}',
  description text,
  tees jsonb not null default '[]',
  par int, length_m numeric, slope int, course_rating numeric,
  image_url text,
  fictional boolean not null default false,
  updated_at timestamptz not null default now()
);
create index if not exists tm_courses_name_key on public.tm_courses(name_key);
alter table public.tm_courses enable row level security;
drop policy if exists read_all on public.tm_courses;
create policy read_all on public.tm_courses for select to authenticated using (true);

-- Stars per course (one rating per course and kind; can be changed any time)
create table if not exists public.course_ratings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  kind round_kind not null,
  course_name text not null,
  course_key text generated always as (public.name_key(course_name)) stored,
  tm_course_id text references public.tm_courses(id),
  stars int not null check (stars between 1 and 5),
  note text,
  rated_at timestamptz not null default now(),
  unique (owner_id, kind, course_key)
);
alter table public.course_ratings enable row level security;
drop policy if exists owner_all on public.course_ratings;
create policy owner_all on public.course_ratings for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- One row per course the player has played (rounds that count), with rating and TrackMan metadata
create or replace function public.course_overview()
returns table (
  kind round_kind, course_name text, rounds bigint, last_played date, best_strokes int, best_to_par int,
  avg_to_par numeric, stars int, note text, tm_course_id text, difficulty int, location text, tags text[]
) language sql stable security invoker set search_path = public as $$
  with r as (
    select rd.kind, btrim(rd.course_name, E' ‎') as course_name, rd.played_on, rd.strokes, rd.par
    from rounds rd
    where rd.superseded_by is null and rd.course_name is not null
      and (rd.counts_in_stats or rd.kind = 'outdoor')
  )
  select r.kind, min(r.course_name), count(*), max(r.played_on), min(r.strokes),
    min(r.strokes - r.par), round(avg(r.strokes - r.par)::numeric, 1),
    max(cr.stars), max(cr.note), max(tc.id), max(tc.difficulty), max(tc.location), max(tc.tags)
  from r
  left join course_ratings cr on cr.kind = r.kind and cr.course_key = public.name_key(r.course_name)
  left join lateral (select * from tm_courses t where r.kind = 'simulator' and t.name_key = public.name_key(r.course_name)
                     order by t.updated_at desc limit 1) tc on true
  group by r.kind, public.name_key(r.course_name)
  order by max(r.played_on) desc;
$$;
grant execute on function public.course_overview() to authenticated;
