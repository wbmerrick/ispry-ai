-- Membership status maintained by api/stripe-webhook.js.
-- The browser cannot read or write this table. Benefit checks and the webhook
-- use the Supabase service role, which bypasses RLS. A missing or stale row
-- falls back to a live Stripe subscription lookup. No clinical text is stored.
-- Safe to re-run.

create table if not exists public.ispry_memberships (
  email text primary key,
  user_id uuid,
  status text not null,
  stripe_customer_id text,
  stripe_subscription_id text,
  cancel_at_period_end boolean not null default false,
  current_period_end timestamptz,
  -- When this status was true in Stripe (event created time, or the live lookup).
  -- A later webhook applies only when its time is at least this new. updated_at
  -- is when we stored the row, and is left alone when an older event is ignored.
  status_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint ispry_memberships_email_check check (
    email = lower(email)
    and char_length(email) <= 120
    and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  constraint ispry_memberships_status_check check (status ~ '^[a-z_]{1,32}$'),
  constraint ispry_memberships_customer_check check (
    stripe_customer_id is null or stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,200}$'
  ),
  constraint ispry_memberships_subscription_check check (
    stripe_subscription_id is null or stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,200}$'
  )
);

create index if not exists ispry_memberships_customer_idx
  on public.ispry_memberships (stripe_customer_id);

create index if not exists ispry_memberships_subscription_idx
  on public.ispry_memberships (stripe_subscription_id);

alter table public.ispry_memberships enable row level security;

revoke all on table public.ispry_memberships from public, anon, authenticated;

grant select, insert, update on table public.ispry_memberships to service_role;

alter table public.ispry_memberships add column if not exists status_at timestamptz;

-- Apply a status only when it is at least as new as the one stored.
-- An older Stripe delivery does not change the row and does not refresh updated_at,
-- so the six-hour benefit cache cannot be revived by a delayed event.
create or replace function public.ispry_apply_membership(
  p_email text,
  p_status text,
  p_status_at timestamptz,
  p_stripe_customer_id text default null,
  p_stripe_subscription_id text default null,
  p_cancel_at_period_end boolean default null,
  p_current_period_end timestamptz default null,
  p_user_id uuid default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $function$
declare
  applied boolean;
begin
  if p_status_at is null then
    return jsonb_build_object('applied', false, 'reason', 'no_event_time');
  end if;

  insert into public.ispry_memberships as m (
    email, status, status_at, stripe_customer_id, stripe_subscription_id,
    cancel_at_period_end, current_period_end, user_id, updated_at
  ) values (
    p_email,
    p_status,
    p_status_at,
    p_stripe_customer_id,
    p_stripe_subscription_id,
    coalesce(p_cancel_at_period_end, false),
    p_current_period_end,
    p_user_id,
    now()
  )
  on conflict (email) do update set
    status = excluded.status,
    status_at = excluded.status_at,
    stripe_customer_id = coalesce(excluded.stripe_customer_id, m.stripe_customer_id),
    stripe_subscription_id = coalesce(excluded.stripe_subscription_id, m.stripe_subscription_id),
    cancel_at_period_end = coalesce(p_cancel_at_period_end, m.cancel_at_period_end),
    current_period_end = coalesce(excluded.current_period_end, m.current_period_end),
    user_id = coalesce(excluded.user_id, m.user_id),
    updated_at = now()
  where m.status_at is null or excluded.status_at >= m.status_at
  returning true into applied;

  if applied is null then
    return jsonb_build_object('applied', false, 'reason', 'stale_event');
  end if;
  return jsonb_build_object('applied', true);
end;
$function$;

revoke all on function public.ispry_apply_membership(text, text, timestamptz, text, text, boolean, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.ispry_apply_membership(text, text, timestamptz, text, text, boolean, timestamptz, uuid)
  to service_role;
