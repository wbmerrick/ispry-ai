-- iSpry patient account profiles (used by public/account.js).
-- Safe to re-run: creates only if missing; policies use DROP IF EXISTS.

create table if not exists public.ispry_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  first_name text not null default '',
  last_name text not null default '',
  age integer not null,
  sex text not null,
  in_tennessee boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ispry_profiles_age_check check (age >= 18 and age <= 120),
  constraint ispry_profiles_sex_check check (sex = any (array['male'::text, 'female'::text]))
);

create or replace function public.ispry_profiles_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

drop trigger if exists ispry_profiles_updated_at on public.ispry_profiles;
create trigger ispry_profiles_updated_at
before update on public.ispry_profiles
for each row
execute function public.ispry_profiles_set_updated_at();

alter table public.ispry_profiles enable row level security;

drop policy if exists ispry_profiles_select_own on public.ispry_profiles;
create policy ispry_profiles_select_own
  on public.ispry_profiles
  for select
  to authenticated
  using (auth.uid() = id);

drop policy if exists ispry_profiles_insert_own on public.ispry_profiles;
create policy ispry_profiles_insert_own
  on public.ispry_profiles
  for insert
  to authenticated
  with check (auth.uid() = id);

drop policy if exists ispry_profiles_update_own on public.ispry_profiles;
create policy ispry_profiles_update_own
  on public.ispry_profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

grant select, insert, update on public.ispry_profiles to authenticated;
