-- Visit rows for ineligibility refunds (api/review.js, api/stripe-webhook.js).
-- A one-time $49 payment is refunded in Stripe when the physician marks the
-- row ineligible. A membership visit is recorded so it can be flagged; the
-- $100 subscription is not refunded here. The browser cannot read or write
-- these tables. The API uses the Supabase service role, which bypasses RLS,
-- and only after it has checked the physician session. No symptoms, synopsis,
-- or message text are stored. Safe to re-run.

create table if not exists public.ispry_requests (
  id uuid primary key,
  user_id uuid,
  email text,
  plan text not null,
  source text not null,
  amount_cents integer,
  stripe_payment_intent_id text,
  stripe_charge_id text,
  stripe_customer_id text,
  stripe_checkout_session_id text,
  akute_patient_id text,
  decision text,
  decided_at timestamptz,
  decided_by uuid,
  refund_id text,
  refund_status text,
  refund_email_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ispry_requests_email_check check (
    email is null
    or (
      email = lower(email)
      and char_length(email) <= 120
      and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    )
  ),
  constraint ispry_requests_plan_check check (plan = any (array['visit'::text, 'membership'::text])),
  constraint ispry_requests_source_check check (source = any (array['checkout'::text, 'handoff'::text, 'member'::text])),
  constraint ispry_requests_amount_check check (amount_cents is null or (amount_cents >= 1 and amount_cents <= 100000)),
  constraint ispry_requests_payment_intent_check check (
    stripe_payment_intent_id is null or stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,200}$'
  ),
  constraint ispry_requests_charge_check check (
    stripe_charge_id is null or stripe_charge_id ~ '^ch_[A-Za-z0-9_]{1,200}$'
  ),
  constraint ispry_requests_customer_check check (
    stripe_customer_id is null or stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,200}$'
  ),
  constraint ispry_requests_checkout_check check (
    stripe_checkout_session_id is null or stripe_checkout_session_id ~ '^cs_[A-Za-z0-9_]{1,200}$'
  ),
  constraint ispry_requests_akute_check check (
    akute_patient_id is null or akute_patient_id ~ '^[A-Za-z0-9_-]{1,200}$'
  ),
  constraint ispry_requests_decision_check check (decision is null or decision = 'ineligible'),
  constraint ispry_requests_refund_id_check check (
    refund_id is null or refund_id ~ '^re_[A-Za-z0-9_]{1,200}$'
  ),
  constraint ispry_requests_refund_status_check check (
    refund_status is null
    or refund_status = any (array[
      'pending'::text,
      'succeeded'::text,
      'failed'::text,
      'partial'::text,
      'member_flagged'::text,
      'needs_review'::text
    ])
  )
);

create unique index if not exists ispry_requests_payment_intent_idx
  on public.ispry_requests (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

create unique index if not exists ispry_requests_checkout_idx
  on public.ispry_requests (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

create index if not exists ispry_requests_charge_idx
  on public.ispry_requests (stripe_charge_id);

create index if not exists ispry_requests_created_idx
  on public.ispry_requests (created_at desc);

alter table public.ispry_requests enable row level security;

revoke all on table public.ispry_requests from public, anon, authenticated;

grant select, insert, update on table public.ispry_requests to service_role;

create table if not exists public.ispry_audit_log (
  id bigint generated always as identity primary key,
  request_id uuid not null,
  actor_id uuid,
  action text not null,
  detail text,
  stripe_refund_id text,
  created_at timestamptz not null default now(),
  constraint ispry_audit_log_action_check check (action ~ '^[a-z_]{1,64}$'),
  constraint ispry_audit_log_detail_check check (detail is null or detail ~ '^[a-z0-9_]{1,80}$'),
  constraint ispry_audit_log_refund_check check (
    stripe_refund_id is null or stripe_refund_id ~ '^re_[A-Za-z0-9_]{1,200}$'
  )
);

create index if not exists ispry_audit_log_request_idx
  on public.ispry_audit_log (request_id, created_at desc);

alter table public.ispry_audit_log enable row level security;

revoke all on table public.ispry_audit_log from public, anon, authenticated;

grant select, insert on table public.ispry_audit_log to service_role;
