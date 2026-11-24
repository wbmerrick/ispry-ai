-- Processed Stripe webhook event ids (api/stripe-webhook.js).
-- The browser cannot read or write this table. The webhook records an id
-- with the Supabase service role, which bypasses RLS, only after the event
-- is handled. Duplicate deliveries are skipped. No payload, email, or
-- chart text is stored. Safe to re-run.

create table if not exists public.ispry_stripe_events (
  event_id text primary key,
  event_type text not null,
  received_at timestamptz not null default now(),
  constraint ispry_stripe_events_id_check check (event_id ~ '^evt_[A-Za-z0-9]{8,200}$'),
  constraint ispry_stripe_events_type_check check (event_type ~ '^[a-z0-9._]{1,80}$')
);

alter table public.ispry_stripe_events enable row level security;

revoke all on table public.ispry_stripe_events from public, anon, authenticated;

grant select, insert on table public.ispry_stripe_events to service_role;
