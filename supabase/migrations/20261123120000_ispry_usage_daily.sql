-- Per-user daily caps for /api/spry, /api/speak, and /api/handoff.
-- The browser cannot read or write this table. The API increments it with
-- the Supabase service role, which bypasses RLS. Caps are Central Time days
-- and must match DAILY_CAPS in api/_lib/usage.js.
-- Safe to re-run.

create table if not exists public.ispry_usage_daily (
  user_id uuid not null,
  day date not null,
  endpoint text not null,
  count integer not null default 0,
  primary key (user_id, day, endpoint),
  constraint ispry_usage_daily_endpoint_check check (endpoint = any (array['spry'::text, 'speak'::text, 'handoff'::text])),
  constraint ispry_usage_daily_count_check check (count >= 0 and count <= 100000)
);

alter table public.ispry_usage_daily enable row level security;

revoke all on table public.ispry_usage_daily from public, anon, authenticated;

create or replace function public.ispry_bump_daily_usage(p_user_id uuid, p_endpoint text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  n integer;
  cap integer;
begin
  cap := case p_endpoint
    when 'spry' then 40
    when 'speak' then 80
    when 'handoff' then 6
    else null
  end;
  if cap is null then
    raise exception 'bad endpoint';
  end if;

  insert into public.ispry_usage_daily as u (user_id, day, endpoint, count)
  values (p_user_id, (timezone('America/Chicago', now()))::date, p_endpoint, 1)
  on conflict (user_id, day, endpoint)
  do update set count = u.count + 1
  returning u.count into n;

  return jsonb_build_object('allowed', n <= cap, 'count', n);
end;
$function$;

revoke all on function public.ispry_bump_daily_usage(uuid, text) from public, anon, authenticated;
grant execute on function public.ispry_bump_daily_usage(uuid, text) to service_role;
