-- 0007_expiry: requests that stop taking payments (W3-C, SPEC §3 T3.3).
--
-- expires_at: optional end of a request, set by the server at creation as now() + expires_in_days (1 to 90);
--   never taken from the client. Past it, a request reads as 'expired' (lib/requests.ts computes it on every
--   read; the stored status stays 'open'). A payment that lands anyway is still found and recorded: money that
--   arrived always shows as paid.
-- cancelled_at, cancel_message, cancel_signature: the recipient's own wallet signed
--   "Owed cancel <id> for <recipient> at <ISO time>" (POST /api/v1/requests/<id>/cancel, lib/cancel.ts).
--   The signed text and signature are kept, so anyone can check that the cancellation came from the wallet the
--   request pays. A late payment to a cancelled request is recorded too (status becomes paid, cancelled_at stays).

alter table requests
  add column expires_at timestamptz,
  add column cancelled_at timestamptz,
  add column cancel_message text,
  add column cancel_signature text;

-- Whole days from 1 to 90 after creation (split shares copy the group's created_at in the same transaction).
alter table requests add constraint requests_expires_check check (
  expires_at is null
  or (expires_at >= created_at + interval '1 day' and expires_at <= created_at + interval '90 days')
);

-- A cancellation always carries its proof (lib/cancel.ts is the only writer of all three).
alter table requests add constraint requests_cancel_check check (
  (cancelled_at is null) = (cancel_message is null)
  and (cancelled_at is null) = (cancel_signature is null)
  and (cancel_message is null or length(cancel_message) <= 200)
  and (cancel_signature is null or length(cancel_signature) <= 200)
);
