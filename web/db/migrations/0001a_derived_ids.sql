-- 0001a_derived_ids: request ids become 12-char hashes of the payment terms (lib/ids.ts).
-- Rows created before this keep their random 10-char ids, so both lengths stay valid.
-- Numbered 0001a so the wave-2 migrations keep 0002 onwards; the runner applies by filename.

alter table requests drop constraint requests_id_check;
alter table requests add constraint requests_id_check
  check (id ~ '^[1-9A-HJ-NP-Za-km-z]{10}([1-9A-HJ-NP-Za-km-z]{2})?$');
