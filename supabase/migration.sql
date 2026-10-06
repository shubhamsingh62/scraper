-- Run once in Supabase Dashboard -> SQL Editor. Safe to re-run.
-- The dinealign job writes only these columns on public.restaurants.
-- id (uuid) and created_at are left to the database.

alter table public.restaurants
  add column if not exists rating numeric,
  add column if not exists review_count text,
  add column if not exists cuisines text[],
  add column if not exists cost_for_two text,
  add column if not exists bar_status text,
  add column if not exists vibe_tags text[],
  add column if not exists must_try text,
  add column if not exists image_urls text[],
  add column if not exists open_until text,
  add column if not exists swiggy_url text,
  add column if not exists zomato_url text,
  add column if not exists current_offer text,
  add column if not exists swiggy_offer text,
  add column if not exists offers_last_checked_at timestamptz;

-- Required for SYNC_MODE=upsert (on_conflict = name,area). Not needed for SYNC_MODE=update.
-- If this fails you already have duplicate (name, area) rows; list them with:
--   select name, area, count(*) from public.restaurants group by 1, 2 having count(*) > 1;
create unique index if not exists restaurants_name_area_key
  on public.restaurants (name, area);
