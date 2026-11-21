-- Efficiency needs circle data for most shots, not all: a single stroke without a target
-- (e.g. a driver past the last circle) no longer turns it off. Threshold: 80 % of the shots.
create or replace function public.warmup_eval(p_sessions uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  r record; blocks jsonb := '[]'; cur jsonb := null; ck text := null;
  d numeric; big boolean; small boolean; rad numeric; trad numeric; tgt numeric;
  n int := 0; nb int := 0; ns int := 0; pts int := 0; nd int := 0; okc int := 0;
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
      big := null; small := null;
    else
      nd := nd + 1; small := d <= trad; big := d <= rad;
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
    'big', nb, 'small', ns, 'points', pts, 'hit_data', n > 0 and nd >= 0.8 * n, 'with_data', nd, 'ok_clubs', okc);
end $$;
select public.detect_warmups();
