-- Total distance in club profiles: P20/P80/P90 for total, and side spread measured at the end of the roll.
drop function if exists public.club_profile(date, date, activity_type[]);
create function public.club_profile(
  p_from date default (current_date - 365),
  p_to date default current_date,
  p_activities activity_type[] default array['practice','map_my_bag','course_play']::activity_type[]
) returns table (
  club text, club_order int, category text, loft numeric, in_bag boolean, full_shots bigint, confidence text,
  mishits bigint, mishit_pct numeric,
  carry_p20 numeric, carry_p50 numeric, carry_p80 numeric, carry_p90 numeric, total_p50 numeric,
  ball_speed_mph numeric, club_speed_mph numeric, smash numeric, launch numeric, spin numeric, dynamic_loft numeric,
  side_mean numeric, side_abs_p80 numeric, side_abs_p95 numeric, left_pct numeric,
  first_shot date, last_shot date,
  total_p20 numeric, total_p80 numeric, total_p90 numeric,
  total_side_mean numeric, total_side_abs_p80 numeric
) language sql stable set search_path = public as $$
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
  select c.name, c.sort_order, c.category, c.loft_deg, coalesce(b.in_bag, false),
    count(*) filter (where f.quality = 'ok'),
    case when count(*) filter (where f.quality = 'ok') >= 50 then 'høy'
         when count(*) filter (where f.quality = 'ok') >= 20 then 'middels' else 'lav' end,
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
    round((select percentile_cont(.5) within group (order by dynamic_loft) from ok where ok.club_id = c.id)::numeric, 1),
    round((select avg(carry_side_m) from ok where ok.club_id = c.id)::numeric, 1),
    round((select percentile_cont(.8) within group (order by abs(carry_side_m)) from ok where ok.club_id = c.id)::numeric, 1),
    round((select percentile_cont(.95) within group (order by abs(carry_side_m)) from ok where ok.club_id = c.id)::numeric, 1),
    round((select 100.0 * count(*) filter (where carry_side_m < 0) / nullif(count(carry_side_m),0) from ok where ok.club_id = c.id)::numeric, 0),
    min(f.started_at)::date, max(f.started_at)::date,
    round((select percentile_cont(.2) within group (order by total_m) from ok where ok.club_id = c.id)::numeric, 1),
    round((select percentile_cont(.8) within group (order by total_m) from ok where ok.club_id = c.id)::numeric, 1),
    round((select percentile_cont(.9) within group (order by total_m) from ok where ok.club_id = c.id)::numeric, 1),
    round((select avg(total_side_m) from ok where ok.club_id = c.id)::numeric, 1),
    round((select percentile_cont(.8) within group (order by abs(total_side_m)) from ok where ok.club_id = c.id)::numeric, 1)
  from f join clubs c on c.id = f.club_id
  left join bag b on b.club_id = c.id
  group by c.id, c.name, c.sort_order, c.category, c.loft_deg, b.in_bag
  order by c.sort_order;
$$;
grant execute on function public.club_profile(date, date, activity_type[]) to authenticated;
