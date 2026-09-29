-- v1 refinement: flag shots that are implausible for the tagged club
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
           (s.pin is not null and s.pin < 0.85 * r.ref_carry) as short_needed,
           -- physically implausible for this club: likely the wrong club was selected
           (s.bs > 1.2 * r.ref_bs or (s.bs > 1.05 * r.ref_bs and s.la < r.ref_la - 12)) as wrong_club
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
      when wrong_club then 'uncertain'
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
      case when stage = 'swing' and poor_strike then 'dårlig treff' end,
      case when stage = 'swing' and wrong_club then 'mulig feil kølle' end)
  from cls;

  get diagnostics n = row_count;
  return jsonb_build_object('classified', n);
end $$;
revoke execute on function public.classify_shots_v1() from public, anon, authenticated;
