-- My Caddie – shot classification v1 and club profiles
-- Derived data only: shot_classifications rows for 'v1' are rebuilt on every run.
-- Manual shot_overrides always win (see v_shots).

create or replace function public.classify_shots_v1() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o uuid := public.app_owner();
  n int;
begin
  delete from shot_classifications where owner_id = o and classifier_version = 'v1';

  with base as (
    select sh.id, sh.club_id, c.category, se.activity, sh.shot_result, sh.launch_lie,
           sh.ball_speed_ms bs, sh.carry_m carry, sh.smash_factor smash, sh.launch_angle la, sh.spin_rate spin,
           sh.dist_to_pin_before_m pin
    from shots sh
    join sessions se on se.id = sh.session_id
    left join clubs c on c.id = sh.club_id
    where sh.owner_id = o
  ),
  -- step 1: non-swings and measurement errors
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
  -- step 2: the player's own full-swing reference per club (valid swings only)
  ref as (
    select club_id,
      percentile_cont(.8) within group (order by bs) as ref_bs,
      count(*) as n_swings
    from s1 where stage = 'swing' and club_id is not null
    group by club_id
  ),
  ref2 as (
    select s.club_id, r.ref_bs,
      percentile_cont(.5) within group (order by s.carry) as ref_carry,
      percentile_cont(.5) within group (order by s.smash) as ref_smash,
      percentile_cont(.5) within group (order by s.la) as ref_la
    from s1 s join ref r using (club_id)
    where s.stage = 'swing' and s.bs >= 0.85 * r.ref_bs
    group by s.club_id, r.ref_bs
  ),
  cls as (
    select s.id, s.stage, s.category, s.activity, s.carry, s.bs, s.pin, s.smash, s.la,
           r.ref_bs, r.ref_carry, r.ref_smash, r.ref_la,
           (s.bs / nullif(r.ref_bs,0)) as bs_ratio,
           (s.carry / nullif(r.ref_carry,0)) as carry_ratio,
           -- poor strike: low smash for this club, or launch far from normal
           (s.smash < 0.92 * r.ref_smash or abs(s.la - r.ref_la) > 7) as poor_strike,
           -- in a round: was a full shot with this club actually needed?
           (s.pin is not null and s.pin >= 0.9 * r.ref_carry) as full_needed,
           (s.pin is not null and s.pin < 0.85 * r.ref_carry) as short_needed
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
      when full_needed then 'full'                         -- tried a full shot in a round, came up short
      when category = 'wedge' then 'partial'               -- wedge principle: never a mishit by speed alone
      when poor_strike and carry_ratio < 0.8 then 'full'   -- slow AND badly struck: a failed full swing
      else 'partial'
    end)::shot_kind,
    (case
      when stage = 'error' then 'measurement_error'
      when stage in ('putt') then 'ok'
      when stage = 'noswing' or ref_bs is null then 'uncertain'
      when carry < 30 or bs_ratio < 0.5 then 'ok'
      when short_needed and (bs_ratio < 0.85 or carry_ratio < 0.85) then 'ok'
      when (bs_ratio >= 0.85 or full_needed or (category <> 'wedge' and poor_strike and carry_ratio < 0.8))
           and carry_ratio < 0.8 and (poor_strike or bs_ratio < 0.85) then 'mishit'
      when bs_ratio >= 0.85 or full_needed then 'ok'
      else 'ok'
    end)::shot_quality,
    concat_ws('; ',
      case stage when 'putt' then 'putt' when 'noswing' then 'ikke et slag' when 'error' then 'målefeil' end,
      case when ref_bs is not null and stage = 'swing' then
        format('fart %s%% · carry %s%% av normal', round(bs_ratio*100), round(carry_ratio*100)) end,
      case when stage = 'swing' and pin is not null then format('%s m til flagg', round(pin)) end,
      case when stage = 'swing' and poor_strike then 'dårlig treff' end)
  from cls;

  get diagnostics n = row_count;
  return jsonb_build_object('classified', n);
end $$;
revoke execute on function public.classify_shots_v1() from public, anon, authenticated;

-- One row per shot with its effective classification (override > v1)
create or replace view public.v_shots with (security_invoker = true) as
select sh.*, se.activity, se.started_at, se.course_name as session_course,
       c.name as club, c.category as club_category, c.sort_order as club_order,
       coalesce(ov.kind, sc.kind) as kind,
       coalesce(ov.quality, sc.quality) as quality,
       coalesce(ov.exclude, false) as excluded,
       sc.reason, (ov.shot_id is not null) as overridden
from shots sh
join sessions se on se.id = sh.session_id
left join clubs c on c.id = sh.club_id
left join shot_classifications sc on sc.shot_id = sh.id and sc.classifier_version = 'v1'
left join shot_overrides ov on ov.shot_id = sh.id;

-- Club profile for a period and a set of activities (full shots only)
create or replace function public.club_profile(
  p_from date default (current_date - 365),
  p_to date default current_date,
  p_activities activity_type[] default array['practice','map_my_bag','course_play']::activity_type[]
) returns table (
  club text, club_order int, category text, in_bag boolean,
  full_shots bigint, mishits bigint, mishit_pct numeric,
  carry_p20 numeric, carry_p50 numeric, carry_p80 numeric, carry_p90 numeric, total_p50 numeric,
  ball_speed_mph numeric, club_speed_mph numeric, smash numeric, launch numeric, spin numeric,
  side_mean numeric, side_abs_p80 numeric, side_abs_p95 numeric, left_pct numeric,
  first_shot date, last_shot date
) language sql stable security invoker set search_path = public as $$
  with f as (
    select * from v_shots
    where kind = 'full' and not excluded and quality in ('ok','mishit')
      and started_at::date between p_from and p_to and activity = any(p_activities)
      and club_id is not null
  ),
  ok as (select * from f where quality = 'ok'),
  bag as (
    select distinct on (club_id) club_id, in_bag from bag_config
    where valid_from <= p_to and (valid_to is null or valid_to >= p_to)
    order by club_id, valid_from desc
  )
  select c.name, c.sort_order, c.category, coalesce(b.in_bag, false),
    count(*) filter (where f.quality = 'ok'),
    count(*) filter (where f.quality = 'mishit'),
    round(100.0 * count(*) filter (where f.quality = 'mishit') / nullif(count(*),0), 1),
    round((select percentile_cont(.2) within group (order by carry_m) from ok where ok.club_id = c.id)::numeric, 1),
    round((select percentile_cont(.5) within group (order by carry_m) from ok where ok.club_id = c.id)::numeric, 1),
    round((select percentile_cont(.8) within group (order by carry_m) from ok where ok.club_id = c.id)::numeric, 1),
    round((select percentile_cont(.9) within group (order by carry_m) from ok where ok.club_id = c.id)::numeric, 1),
    round((select percentile_cont(.5) within group (order by total_m) from ok where ok.club_id = c.id)::numeric, 1),
    round((select percentile_cont(.5) within group (order by ball_speed_ms) from ok where ok.club_id = c.id)::numeric * 2.23694, 1),
    round((select percentile_cont(.5) within group (order by club_speed_ms) from ok where ok.club_id = c.id)::numeric * 2.23694, 1),
    round((select percentile_cont(.5) within group (order by smash_factor) from ok where ok.club_id = c.id)::numeric, 2),
    round((select percentile_cont(.5) within group (order by launch_angle) from ok where ok.club_id = c.id)::numeric, 1),
    round((select percentile_cont(.5) within group (order by spin_rate) from ok where ok.club_id = c.id)::numeric, 0),
    round((select avg(carry_side_m) from ok where ok.club_id = c.id)::numeric, 1),
    round((select percentile_cont(.8) within group (order by abs(carry_side_m)) from ok where ok.club_id = c.id)::numeric, 1),
    round((select percentile_cont(.95) within group (order by abs(carry_side_m)) from ok where ok.club_id = c.id)::numeric, 1),
    round((select 100.0 * count(*) filter (where carry_side_m < 0) / nullif(count(carry_side_m),0) from ok where ok.club_id = c.id)::numeric, 0),
    min(f.started_at)::date, max(f.started_at)::date
  from f join clubs c on c.id = f.club_id
  left join bag b on b.club_id = c.id
  group by c.id, c.name, c.sort_order, c.category, b.in_bag
  order by c.sort_order;
$$;
grant execute on function public.club_profile(date, date, activity_type[]) to authenticated;

-- Classification runs after every import so new shots are always classified
create or replace function public.sync_import(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare res jsonb;
begin
  if auth.uid() is null or auth.uid() <> public.app_owner() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if (p->'source'->>'type') <> 'trackman_api' then
    raise exception 'sync_import only accepts trackman_api sources' using errcode = '22023';
  end if;
  if jsonb_typeof(p->'round') is distinct from 'object' then
    p := p - 'round';
  end if;
  res := public.import_trackman(p || jsonb_build_object('channel', 'extension'));
  if (res->>'shots_new')::int > 0 then perform public.classify_shots_v1(); end if;
  return res;
end $$;
revoke execute on function public.sync_import(jsonb) from public, anon;
grant execute on function public.sync_import(jsonb) to authenticated;
