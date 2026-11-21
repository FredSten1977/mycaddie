-- A warm-up can be split into several TrackMan sessions (e.g. the player restarts Virtual Range
-- halfway through the bag). Sessions by the same player that start less than 45 minutes after the
-- previous one form one group, evaluated as a single warm-up.
alter table public.warmup_duels
  add column if not exists p1_sessions uuid[],
  add column if not exists p2_sessions uuid[];
update public.warmup_duels set p1_sessions = array[p1_session] where p1_sessions is null;
update public.warmup_duels set p2_sessions = array[p2_session] where p2_sessions is null;

-- warmup_eval over a group of sessions (shots in time order across the sessions)
create or replace function public.warmup_eval(p_sessions uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  r record; blocks jsonb := '[]'; cur jsonb := null; ck text := null;
  d numeric; big boolean; small boolean; rad numeric; trad numeric; tgt numeric;
  n int := 0; nb int := 0; ns int := 0; pts int := 0; hitdata boolean := true; okc int := 0;
  sh int; b int; s int; done_at int;
begin
  for r in
    select x.shot_time, coalesce(x.raw->>'club', x.club_raw) club_raw, coalesce(c.name, x.raw->>'club', x.club_raw) club_name,
           x.carry_m, x.carry_side_m,
           coalesce((x.raw->'target'->>'distance')::numeric, (x.raw->>'targetDistance')::numeric) tgt,
           (x.raw->'target'->>'radius')::numeric r1, (x.raw->'target'->>'tourRadius')::numeric r2
    from shots x left join clubs c on c.id = x.club_id
    where x.session_id = any(p_sessions)
    order by x.shot_time, x.shot_no
  loop
    if ck is distinct from public.warmup_club_key(r.club_raw) then
      if cur is not null then blocks := blocks || cur; end if;
      ck := public.warmup_club_key(r.club_raw);
      cur := jsonb_build_object('club', ck, 'name', r.club_name, 'tgt', round(r.tgt), 'shots', 0, 'big', 0, 'small', 0,
                                'done_at', null, 'hits', '[]'::jsonb, 'd', '[]'::jsonb);
    end if;
    n := n + 1;
    sh := (cur->>'shots')::int + 1; b := (cur->>'big')::int; s := (cur->>'small')::int;
    rad := greatest(r.r1, r.r2); trad := least(r.r1, r.r2); tgt := r.tgt;
    -- distance from the target to where the ball landed (carry), as TrackMan's "From target"
    d := case when r.carry_m is null or tgt is null then null else sqrt(power(r.carry_m - tgt, 2) + power(coalesce(r.carry_side_m, 0), 2)) end;
    if rad is null or d is null then
      hitdata := false; big := null; small := null;
    else
      small := d <= trad; big := d <= rad;
      if small then s := s + 1; b := b + 1; pts := pts + 2; ns := ns + 1; nb := nb + 1;
      elsif big then b := b + 1; pts := pts + 1; nb := nb + 1; end if;
    end if;
    done_at := (cur->>'done_at')::int;
    if done_at is null and (s >= 1 or b >= 2) then done_at := sh; end if;
    cur := cur || jsonb_build_object('shots', sh, 'big', b, 'small', s, 'done_at', done_at,
                                     'hits', (cur->'hits') || coalesce(to_jsonb(case when small then 2 when big then 1 when big is null then null else 0 end), 'null'::jsonb),
                                     'd', (cur->'d') || coalesce(to_jsonb(round(d, 1)), 'null'::jsonb));
  end loop;
  if cur is not null then blocks := blocks || cur; end if;
  select count(*) into okc from jsonb_array_elements(blocks) z where (z->>'done_at')::int = (z->>'shots')::int;
  return jsonb_build_object('blocks', blocks, 'shots', n, 'clubs', jsonb_array_length(blocks),
    'big', nb, 'small', ns, 'points', pts, 'hit_data', hitdata and n > 0, 'ok_clubs', okc);
end $$;
revoke execute on function public.warmup_eval(uuid[]) from public, anon, authenticated;
drop function if exists public.warmup_eval(uuid);

create or replace function public.detect_warmups(p_day date default null, p_force boolean default false) returns int
language plpgsql security definer set search_path = public as $$
declare pr record; e1 jsonb; e2 jsonb; k int := 0; st text; has_match boolean;
begin
  for pr in
    with vr as (
      select s.id, s.owner_id, s.started_at, (s.started_at at time zone 'Europe/Oslo')::date d,
             (select count(*) from shots x where x.session_id = s.id) n
      from sessions s where s.trackman_kind = 'VIRTUAL_RANGE'
        and (p_day is null or (s.started_at at time zone 'Europe/Oslo')::date = p_day)
    ),
    marked as (
      select *, case when started_at - lag(started_at) over (partition by owner_id, d order by started_at) < interval '45 minutes'
                     then 0 else 1 end as brk
      from vr where n > 0
    ),
    grp as (
      select owner_id, d, sum(brk) over (partition by owner_id, d order by started_at) g, id, started_at, n from marked
    ),
    cl as (
      select owner_id, d, g, array_agg(id order by started_at) ids, min(started_at) started_at, sum(n) n
      from grp group by owner_id, d, g
    ),
    pairs as (
      select a.ids s1, b.ids s2, a.owner_id u1, b.owner_id u2, a.d,
             row_number() over (partition by a.owner_id, b.owner_id, a.d
                                order by abs(extract(epoch from a.started_at - b.started_at)), a.n + b.n desc) rn
      from cl a join cl b on b.d = a.d and b.owner_id <> a.owner_id
      join auth.users ua on ua.id = a.owner_id join auth.users ub on ub.id = b.owner_id
      where ua.created_at < ub.created_at                   -- each pair once; p1 = the older account (as in matches)
        and a.n >= 3 and b.n >= 3
        and (p_force or abs(extract(epoch from a.started_at - b.started_at)) < 3 * 3600)
    )
    select * from pairs where rn = 1
  loop
    e1 := public.warmup_eval(pr.s1);
    e2 := public.warmup_eval(pr.s2);
    if not p_force and ((e1->>'clubs')::int < 3 or (e2->>'clubs')::int < 3) then continue; end if;
    select exists (select 1 from matches m where m.played_on = pr.d
                   and ((m.p1_user = pr.u1 and m.p2_user = pr.u2) or (m.p1_user = pr.u2 and m.p2_user = pr.u1))) into has_match;
    st := case when p_force then 'bekreftet' when has_match then 'auto' else 'kandidat' end;
    -- a different session group the same day replaces an undecided one
    delete from warmup_duels w where w.played_on = pr.d and w.p1_user = pr.u1 and w.p2_user = pr.u2
      and (w.p1_session, w.p2_session) <> (pr.s1[1], pr.s2[1]) and (p_force or w.status in ('auto', 'kandidat'));
    insert into warmup_duels(played_on, p1_user, p2_user, p1_session, p2_session, p1_sessions, p2_sessions, p1_name, p2_name, status, e1, e2, result)
    values (pr.d, pr.u1, pr.u2, pr.s1[1], pr.s2[1], pr.s1, pr.s2, public.player_name(pr.u1), public.player_name(pr.u2), st, e1, e2, public.warmup_score(e1, e2))
    on conflict (p1_session, p2_session) do update
      set e1 = excluded.e1, e2 = excluded.e2, result = excluded.result, p1_name = excluded.p1_name, p2_name = excluded.p2_name,
          p1_sessions = excluded.p1_sessions, p2_sessions = excluded.p2_sessions,
          status = case when p_force then 'bekreftet'
                        when warmup_duels.status in ('bekreftet', 'avvist') then warmup_duels.status
                        else excluded.status end,
          updated_at = now();
    k := k + 1;
  end loop;
  return k;
end $$;
revoke execute on function public.detect_warmups(date, boolean) from public, anon;
grant execute on function public.detect_warmups(date, boolean) to authenticated;
