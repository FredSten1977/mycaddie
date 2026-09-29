-- When a course was added to TrackMan (from the public catalog), for the "Nyeste" list in the app
alter table public.tm_courses
  add column if not exists tm_created_at timestamptz,
  add column if not exists available_from timestamptz,
  add column if not exists tm_updated_at timestamptz,
  add column if not exists version text;
