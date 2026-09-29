-- Multi-user (applied 2026-09-29 as migrations multi_user, multi_user_bag_defaults, current_owner_definer)
-- current_owner(): the signed-in user; SQL maintenance without a login falls back to the original owner.
create or replace function public.current_owner() returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(auth.uid(), nullif(current_setting('mycaddie.owner', true), '')::uuid, public.app_owner())
$$;
revoke execute on function public.current_owner() from public, anon;
grant execute on function public.current_owner() to authenticated;

-- Every function that used app_owner() now uses current_owner() (import, sync, classification, club review).
do $$
declare r record; src text;
begin
  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.prosrc ilike '%app_owner%'
      and p.proname not in ('app_owner', 'current_owner')
  loop
    src := pg_get_functiondef(r.oid);
    src := replace(src, 'public.app_owner()', 'public.current_owner()');
    src := replace(src, ' app_owner()', ' public.current_owner()');
    src := replace(src, '(app_owner()', '(public.current_owner()');
    execute src;
  end loop;
end $$;

-- New users without a bag set-up: every club they hit counts as "in the bag" until they save their bag.
create or replace function public.has_bag() returns boolean
language sql stable set search_path = public as $$ select exists (select 1 from bag_config where owner_id = public.current_owner()) $$;
grant execute on function public.has_bag() to authenticated;

create or replace function public.set_bag(p_in_bag uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o uuid := auth.uid(); n int;
begin
  if o is null then raise exception 'not signed in' using errcode = '42501'; end if;
  delete from bag_config where owner_id = o and valid_from = current_date;
  update bag_config set valid_to = current_date - 1 where owner_id = o and valid_to is null;
  insert into bag_config(owner_id, club_id, in_bag, valid_from, note)
  select o, c.id, c.id = any(p_in_bag), current_date, 'satt i appen'
  from clubs c where c.owner_id = o and c.category is distinct from 'putter';
  get diagnostics n = row_count;
  return jsonb_build_object('clubs', n);
end $$;
revoke execute on function public.set_bag(uuid[]) from public, anon;
grant execute on function public.set_bag(uuid[]) to authenticated;

do $$
declare src text;
begin
  src := pg_get_functiondef('public.club_profile(date,date,activity_type[])'::regprocedure);
  src := replace(src, 'coalesce(b.in_bag, false)', 'coalesce(b.in_bag, not public.has_bag())');
  execute src;
  src := pg_get_functiondef('public.review_queue(int)'::regprocedure);
  src := replace(src, 'where exists (select 1 from bag_config b where b.club_id = c.id and b.in_bag',
                      'where (not public.has_bag() or exists (select 1 from bag_config b where b.club_id = c.id and b.in_bag');
  src := replace(src, 'and (b.valid_to is null or b.valid_to >= q.started_at::date))',
                      'and (b.valid_to is null or b.valid_to >= q.started_at::date)))');
  execute src;
end $$;
