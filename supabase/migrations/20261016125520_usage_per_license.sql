-- Count usage per Polar license (its id stays the same when a customer
-- rotates the key), so rotating a key does not reset the monthly allowance.
-- (Replaces public.usage and its functions from the previous migration.)
alter table public.licenses add column license_id text;

create table public.license_usage (
  license_id text not null,
  month date not null,
  requests integer not null default 0 check (requests >= 0),
  primary key (license_id, month)
);
alter table public.license_usage enable row level security;
revoke all on public.license_usage from anon, authenticated;

-- Count one request for this month. Returns the new count, or null when the
-- limit is already reached (nothing is counted then).
create function public.use_ocr_request(p_license_id text, p_limit integer)
returns integer
language sql
set search_path = ''
as $$
  insert into public.license_usage as u (license_id, month, requests)
  values (p_license_id, (date_trunc('month', now() at time zone 'utc'))::date, 1)
  on conflict (license_id, month) do update
    set requests = u.requests + 1
    where u.requests < p_limit
  returning requests;
$$;

-- Give a request back (the recognition failed).
create function public.give_back_ocr_request(p_license_id text)
returns void
language sql
set search_path = ''
as $$
  update public.license_usage
  set requests = greatest(requests - 1, 0)
  where license_id = p_license_id
    and month = (date_trunc('month', now() at time zone 'utc'))::date;
$$;

-- This month's count (0 when nothing was used yet).
create function public.ocr_requests_this_month(p_license_id text)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select requests from public.license_usage
     where license_id = p_license_id
       and month = (date_trunc('month', now() at time zone 'utc'))::date),
    0);
$$;

revoke all on function public.use_ocr_request(text, integer) from public, anon, authenticated;
revoke all on function public.give_back_ocr_request(text) from public, anon, authenticated;
revoke all on function public.ocr_requests_this_month(text) from public, anon, authenticated;
grant execute on function public.use_ocr_request(text, integer) to service_role;
grant execute on function public.give_back_ocr_request(text) to service_role;
grant execute on function public.ocr_requests_this_month(text) to service_role;
