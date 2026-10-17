-- 0011_base_requests: USDC requests on Base (sprint W3-B). `requests.chain` exists since 0001
-- (default 'solana'); this pins what a Base row may hold and how it gets paid.
-- - A Base request is a single USDC request to a checksummed 0x address. Its id still hashes the
--   terms, with the chain in the preimage (lib/ids.ts); `reference` stays a random 32-byte key
--   that only feeds the id.
-- - It is paid by a USDC Transfer to the recipient, found in Base logs (paid_rail 'base_transfer'),
--   or over x402 on eip155:8453 (paid_rail 'x402'). paid_signature holds the transaction hash, so
--   requests_paid_signature_key keeps "one transaction settles one request" across both chains.
-- - chain_cursor: the last Base block already scanned for this request's payment, so a status
--   check reads only new blocks (public Base RPCs serve old logs 1,000 blocks at a time).

alter table requests add column if not exists chain_cursor bigint;

alter table requests drop constraint if exists requests_chain_check;
alter table requests add constraint requests_chain_check check (chain in ('solana', 'base'));

alter table requests drop constraint if exists requests_paid_rail_check;
alter table requests add constraint requests_paid_rail_check
  check (paid_rail in ('solana_pay', 'x402', 'base_transfer'));

alter table requests drop constraint if exists requests_base_shape;
alter table requests add constraint requests_base_shape check (
  chain <> 'base'
  or (kind = 'single'
      and token = 'USDC'
      and mint = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
      and decimals = 6
      and recipient ~ '^0x[0-9a-fA-F]{40}$'
      and (paid_signature is null or paid_signature ~ '^0x[0-9a-f]{64}$')
      and (paid_rail is null or paid_rail in ('base_transfer', 'x402')))
);
alter table requests drop constraint if exists requests_solana_rail;
alter table requests add constraint requests_solana_rail check (chain <> 'solana' or paid_rail is distinct from 'base_transfer');

-- Status checks read a recipient's open Base requests oldest first (lib/evm/settle.ts).
create index if not exists requests_base_open_idx on requests (recipient, created_at)
  where chain = 'base' and status = 'open';
