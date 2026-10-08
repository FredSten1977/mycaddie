-- Average swing numbers per club for the small table under the dispersion view in "Min bag".
-- Same shot selection as club_profile: good full shots (quality 'ok'), not excluded, effective club.
create or replace function public.club_swing_avgs(
  p_from date default (current_date - 365),
  p_to date default current_date,
  p_activities activity_type[] default array['practice','map_my_bag','course_play']::activity_type[]
) returns table (
  club text, club_order int, shots bigint,
  club_path_avg numeric, face_angle_avg numeric, ball_speed_mph numeric, club_speed_mph numeric
) language sql stable set search_path = public as $$
  select c.name, c.sort_order, count(*),
    round(avg(v.club_path)::numeric, 1),
    round(avg(v.face_angle)::numeric, 1),
    round(avg(v.ball_speed_ms)::numeric * 2.23694, 1),
    round(avg(v.club_speed_ms)::numeric * 2.23694, 1)
  from v_shots v join clubs c on c.id = v.club_id
  where v.kind = 'full' and not v.excluded and v.quality = 'ok'
    and v.started_at::date between p_from and p_to and v.activity = any(p_activities)
  group by c.id, c.name, c.sort_order
  order by c.sort_order;
$$;
revoke execute on function public.club_swing_avgs(date, date, activity_type[]) from public, anon;
grant execute on function public.club_swing_avgs(date, date, activity_type[]) to authenticated;
