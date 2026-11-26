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
