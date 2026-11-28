-- Review queue and patient status-mail claims.
-- api/stale-queue.js and api/akute-webhook.js use the service role, which
-- bypasses RLS. The browser cannot read or write these tables.
-- Rows store an email and opaque Akute ids so a status email can be sent
-- once. No clinical text is stored.
-- Safe to re-run.

create table if not exists public.ispry_review_queue (
  id uuid primary key default gen_random_uuid(),
  external_key text not null unique,
  source text not null,
  status text not null,
  patient_email text not null,
  akute_patient_id text,
  akute_task_id text,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  closed_at timestamptz,
  stale_alerted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint ispry_review_queue_key_check check (
    external_key ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,159}$'
  ),
  constraint ispry_review_queue_source_check check (
    source = any (array['intake'::text, 'member_request'::text, 'stripe_visit'::text, 'stripe_membership'::text])
  ),
  constraint ispry_review_queue_status_check check (
    status = any (array['awaiting_payment'::text, 'queued'::text, 'reviewed'::text, 'closed'::text])
  ),
  constraint ispry_review_queue_email_check check (
    patient_email = lower(patient_email)
    and char_length(patient_email) <= 120
    and patient_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  constraint ispry_review_queue_patient_check check (
    akute_patient_id is null or akute_patient_id ~ '^[A-Za-z0-9_-]{1,80}$'
  ),
  constraint ispry_review_queue_task_check check (
    akute_task_id is null or akute_task_id ~ '^[A-Za-z0-9_-]{1,80}$'
  )
);

create index if not exists ispry_review_queue_stale_idx
  on public.ispry_review_queue (submitted_at)
  where status = 'queued';

create index if not exists ispry_review_queue_patient_idx
  on public.ispry_review_queue (akute_patient_id);

create index if not exists ispry_review_queue_task_idx
  on public.ispry_review_queue (akute_task_id);

alter table public.ispry_review_queue enable row level security;

revoke all on table public.ispry_review_queue from public, anon, authenticated;

grant select, insert, update on table public.ispry_review_queue to service_role;

-- One row per status email. The key is claimed before the send and removed
-- if the send fails, so a retry can try again and a duplicate delivery cannot.
create table if not exists public.ispry_status_notices (
  notice_key text primary key,
  kind text not null,
  sent_at timestamptz not null default now(),
  constraint ispry_status_notices_key_check check (
    notice_key ~ '^(received|reviewed|rx):[A-Za-z0-9_:-]{4,160}$'
  ),
  constraint ispry_status_notices_kind_check check (
    kind = any (array['received'::text, 'reviewed'::text, 'rx_sent'::text])
  )
);

alter table public.ispry_status_notices enable row level security;

revoke all on table public.ispry_status_notices from public, anon, authenticated;

grant select, insert, delete on table public.ispry_status_notices to service_role;
