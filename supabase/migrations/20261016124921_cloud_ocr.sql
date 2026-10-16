-- Ink Notebook Cloud: license cache and monthly usage.
-- Only the ocr edge function (service role) touches these tables; RLS is on
-- with no policies so the public API keys cannot read or write them.

-- License keys are stored only as SHA-256 hashes.
create table public.licenses (
  key_hash text primary key,
  status text not null check (status in ('active', 'inactive')),
  expires_at timestamptz,
  checked_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- One row per license key and month (first day of the month, UTC).
create table public.usage (
  key_hash text not null references public.licenses (key_hash) on delete cascade,
  month date not null,
  requests integer not null default 0 check (requests >= 0),
  primary key (key_hash, month)
);

alter table public.licenses enable row level security;
alter table public.usage enable row level security;
revoke all on public.licenses, public.usage from anon, authenticated;

-- Count one request for this month. Returns the new count, or null when the
-- limit is already reached (nothing is counted then).
create function public.consume_ocr_request(p_key_hash text, p_limit integer)
returns integer
language sql
set search_path = ''
as $$
  insert into public.usage as u (key_hash, month, requests)
  values (p_key_hash, (date_trunc('month', now() at time zone 'utc'))::date, 1)
  on conflict (key_hash, month) do update
    set requests = u.requests + 1
    where u.requests < p_limit
  returning requests;
$$;

-- Give a request back (the recognition failed).
create function public.refund_ocr_request(p_key_hash text)
returns void
language sql
set search_path = ''
as $$
  update public.usage
  set requests = greatest(requests - 1, 0)
  where key_hash = p_key_hash
    and month = (date_trunc('month', now() at time zone 'utc'))::date;
$$;

revoke all on function public.consume_ocr_request(text, integer) from public, anon, authenticated;
revoke all on function public.refund_ocr_request(text) from public, anon, authenticated;
grant execute on function public.consume_ocr_request(text, integer) to service_role;
grant execute on function public.refund_ocr_request(text) to service_role;
