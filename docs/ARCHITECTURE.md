# Architecture

Owed is a PayBox plugin plus a small web service. The plugin is what an agent calls; the web service stores requests, serves the pages people pay from, and checks Solana (and Base, for Base requests) for payments. Neither one holds money: every payment is a single transaction from the payer's wallet to the recipient.

```mermaid
flowchart LR
  subgraph PayBox
    A[Agent<br/>Claude or any MCP client] -->|use_plugin| P[Owed plugin<br/>dist/plugin.mjs<br/>fresh sandbox per call, 10 s]
    P -->|unsigned proposal| W[PayBox wallet<br/>passkey approval]
  end
  P -->|HTTPS /api/v1| S[Owed web<br/>Next.js on Vercel<br/>www.getowed.xyz]
  P -->|JSON-RPC| R[(Solana mainnet<br/>publicnode, mainnet-beta)]
  P -->|DNS-over-HTTPS| D[cloudflare-dns.com<br/>dns.google]
  S --> DB[(Neon Postgres)]
  S -->|JSON-RPC| R
  S -->|JSON-RPC| B[(Base mainnet<br/>publicnode, Tenderly)]
  S -->|DNS-over-HTTPS| D
  H[Helius webhook] -->|POST /api/hooks/helius| S
  C[Vercel Cron, daily] -->|/api/cron/schedules| S
  X[Payer's wallet app] -->|scans the QR: GET/POST /api/v1/pay/id| S
  X -->|one transaction| R
  W -->|signed by the payer| R
  E[Base wallet] -->|one USDC transfer| B
```

## The plugin (`plugin/`)

- A TypeScript MCP server over stdio, built from the PayBox plugin starter v1.0.2 and bundled with esbuild to one ESM file, `plugin/dist/plugin.mjs`. Two builds must be byte-identical (`pnpm test`), so nothing reads the clock or randomness at module load.
- PayBox starts a fresh process for every call and gives it 10 seconds. There is no network at startup or during tool discovery. During a call it may reach only the hosts configured in the portal, over HTTPS: the Owed host, two Solana RPC hosts and two DNS-over-HTTPS hosts. There are no secrets: the only variable is `OWED_BASE_URL`, which isn't secret.
- Budgets inside the 10 s: the Owed API gets 4 s per call; Solana reads get 5.5 s, with 3 s per RPC host before falling through to the next; DNS gets 2.5 s per resolver. `pay_link` runs its DNS check alongside the balance check.
- Eleven tools: `ask_for_money`, `check_payments`, `pay_link`, `verify_payee`, `split_bill`, `create_invoice`, `who_owes_me`, `write_reminder`, `ask_every_month`, `cancel_request`, `match_payments` (0012: payments without the reference, matched by the recipient). Tools that move money return a PayBox proposal (`io.paybox/transactionProposal`). The plugin never signs; the user approves in PayBox with a passkey.
- If the Owed API is unreachable, `ask_for_money` still returns a working Solana Pay link (shown on the stateless `/p` page), and `check_payments` checks raw Solana Pay links directly on chain. Asks that need the server (a local currency, a Base request) refuse instead and say why.
- SNS names (`plugin/src/sns.ts`) are resolved over the same Solana RPC hosts, so they add no host to the portal's allowlist.

## The web service (`web/`)

- Next.js 16 on Vercel, Node runtime for every route. JSON API at `/api/v1`: create and read requests, groups and invoices; batch status (`POST /status`, up to 20 ids); status for a raw Solana Pay link (`POST /status-raw`); stats; the signed ledger behind `who_owes_me` (`POST /ledger`, `GET /ledger/csv` for a 10-minute CSV link); monthly schedules (`POST /schedules`); a recipient-signed cancel (`POST /requests/<id>/cancel`); a payment matched by the recipient (`POST /requests/<id>/match`, signed, re-verified on chain), the rest of an underpaid request (`POST /requests/<id>/rest`) and what is already counted (`POST /attributed`); and the Solana Pay transaction request the QR encodes (`GET`/`POST /pay/<id>`). Errors are always `{error:{code,message}}`.
- Outside `/api/v1`: `/api/hooks/helius` (Helius webhook), `/api/cron/schedules` (Vercel Cron, daily at 00:07 UTC), `/api/qr/<id>.png`, and, only when MoonPay is configured, `/api/moonpay/<id>` and `/api/hooks/moonpay`.
- Pages: `/r/<id>` (pay page: QR, wallet button, live status, receipt), `/g/<id>` (split board), `/i/<id>` (printable invoice), `/x/<id>` (x402 endpoint), `/p?u=<solana: URL>` (stateless page), `/proof` (the team's own payments on every rail, and what Owed refuses), the landing page and `llms.txt`.
- Storage: Neon Postgres, reached over its SQL-over-HTTP endpoint. Production and previews use separate databases, so previews and smoke runs never write production rows. Schema changes are numbered files in `web/db/migrations/`, applied with `web/scripts/migrate.sh`.
- Requester text (names, "for", notes, invoice lines) is cleaned on the way in: links and invisible characters stripped, double quotes replaced, length capped. Pages show it in quotes, labelled as written by the requester, and isolated for right-to-left scripts. A brand word in the text, or in a verified domain, adds a caution banner. Creation is rate-limited per recipient and globally.

## A request's life

1. **Create.** The server picks a random 32-byte reference and derives the request id from the terms: the last 12 base58 characters of `sha256("owed-request:v1", recipient, asset, atomic amount, reference)` (`web/lib/ids.ts`, `plugin/src/request-id.ts`). The Solana Pay URL carries the recipient, amount, USDC mint (for USDC), the reference and the memo `owed:<id>`. `ask_for_money` refuses a hosted link whose id doesn't hash its terms.
2. **Pay.** A wallet scans the QR, which is a Solana Pay transaction request (`solana:https://www.getowed.xyz/api/v1/pay/<id>`, `web/lib/pay-tx.ts`): the wallet sends its address, Owed builds the transaction (the same layout as below, with the reference and memo inside) and the wallet only signs it. Phantom's scanner turns a scanned *transfer* URL into a plain send that drops the reference, which is why the QR doesn't encode one; the transfer URL is still returned to agents and shown as a link.    Or `pay_link` resolves the link, checks the request is open and the sender can cover the amount plus about 0.003 SOL for fees, and builds one legacy transaction: the recipient's USDC account if it's missing (created idempotently), the memo, and `transferChecked` (USDC) or a system transfer (SOL), with the reference as a read-only key. The size limit is 1,232 bytes.
3. **Check.** A request is paid only by one confirmed, successful transaction that carries its reference and credits the recipient with at least the amount. For USDC that's the net change across the recipient's USDC accounts; for SOL it's lamports. Less is underpaid; credits to anyone else, other mints and failed transactions are ignored. Reads accept version-1 transactions, which mainnet carries. Because a reference is public, the check reads the reference's whole history, drops failed transactions and reads oldest first. A transaction that carries several requests' references settles only one of them. The server writes "paid" once; a unique signature index stops one transaction from settling two requests. The plugin applies the same rules when it checks a raw link directly.
4. **Settle without anyone looking.** A Helius webhook (`/api/hooks/helius`, shared-secret header) reports transactions that touch Owed references. The route answers at once, then re-checks each referenced request on chain through the normal settle path; the webhook body itself never marks anything paid. Preview deployments don't register a webhook. Status reads (`POST /status`, the pay page) settle the same way, so a request is marked paid whether or not the page is open.

### Other rails and sources

- **Base (USDC, chain 8453).** `ask_for_money` with `chain: "base"` stores a Base recipient (EIP-55 checksummed; a mistyped mixed-case address is refused, never "fixed") and returns an EIP-681 link (`ethereum:<USDC>@8453/transfer?address=<recipient>&uint256=<atomic>`). Base has no reference key, so the server reads USDC `Transfer` logs to the recipient through `base-rpc.publicnode.com` (and Tenderly's gateway for older blocks) and matches every open Base request to that recipient together: exact amount, after the request was made, oldest request first, one transaction per request (`web/lib/evm/`). Each request keeps a cursor, so a check reads only blocks it hasn't seen. `pay_link` never builds a Solana transaction for a Base request; it pays over x402 on `eip155:8453` from the user's PayBox Base wallet. Rail `base_transfer`.
- **Monthly schedules.** `ask_every_month` stores a schedule (`POST /schedules`). A daily Vercel Cron opens that month's request through the normal create path, idempotently per schedule and month, and refuses any call without `CRON_SECRET`. Each month's request is an ordinary request.
- **Matched payments (rail `matched`).** A transfer without the reference counts only through `POST /requests/<id>/match`: the recipient's ed25519 signature over `Owed match <tx> to <id> for <recipient> at <ISO>` (5 minutes, single use), then a chain check that the transaction is confirmed, successful, credits the recipient exactly what is still due, landed after the request, names no Owed reference and isn't counted elsewhere. The signed message is stored as the proof.
- **Pay by card with MoonPay (rail `moonpay_card`, off by default).** With `NEXT_PUBLIC_OWED_MOONPAY=1` and a matching MoonPay key pair, the pay and invoice pages offer "Pay by card (MoonPay)". `/api/moonpay/<id>` signs MoonPay's widget URL on the server (USDC on Solana, exactly the amount owed, delivered to the recipient, the request id as `externalTransactionId`, bound to the payer's IP) and redirects. MoonPay's delivery is a plain transfer with no reference, so MoonPay's report (signed webhook or its API) only names *which* Solana transaction to look at; Owed marks the request paid only when that transaction credits the recipient on chain (`web/lib/moonpay/attribution.ts`). Sandbox keys label the button "Sandbox"; without keys nothing about MoonPay renders or runs. Production has it off.

## What each part guarantees

- **Non-custodial.** The payer's own wallet sends the money to the recipient in one transaction. Owed has no wallet and adds no fee instruction.
- **The id commits to the payment (Solana Pay rail).** `pay_link` recomputes the id from what `GET /api/v1/requests/<id>` returns, and refuses unless it matches and the server's Solana Pay URL pays exactly those terms. So the server can't change who gets paid or how much behind a link that was already shared: different terms would need a different id. Older random 10-character ids stay readable, but `pay_link` refuses them.
- **x402 rail.** Every request also has an x402 endpoint at `/x/<id>`. With `rail: "x402"`, your agent checks the id and the live x402 challenge against the request before it proposes the payment. PayBox fetches the challenge again when it pays, so "the server can't change who gets paid" is a Solana Pay guarantee only. The first x402 settle on mainnet was request `FeJG9SuofqWU`, 0.01 USDC through PayBox `pay_x402`, with the facilitator as fee payer (docs/FACTS.md).
- **Verified payee.** A requester proves a domain with a DNS TXT record `_owed.<domain>` → `owed-pay=<wallet>` (one record per wallet).
  - The plugin reads that record itself over DNS-over-HTTPS (cloudflare-dns.com, then dns.google). It reports DNSSEC from the resolver's AD flag and warns on internationalized names, mixed scripts, lookalike and digit-for-letter spellings, brand words in the name (each brand's own domains excepted), and names placed in front of another domain.
  - `pay_link` refuses a request whose domain doesn't list its wallet. If DNS can't be read, it refuses unless the user explicitly passes `allow_unverified`, and even then a domain that answers "no" is never paid.
  - The server re-checks the record when a request is created, within a shorter budget than the plugin's API timeout, and stores the domain for display only. The plugin never trusts that copy.
  - "Verified" means the domain lists the wallet. It says who controls the domain, not that the request is fair.
- **Local-currency asks lock USDC, not a promise.** `ask_for_money`, `split_bill` and `create_invoice` take `currency` (an ISO 4217 code from a list of 38, never USD). The server, not the plugin, fetches the rate, so the plugin's hosts don't change (`web/lib/fx.ts`):
  - Rate = Coinbase's USD table (currency per USD ÷ USDC per USD, one response), cross-checked against open.er-api.com's daily USD table. Both up and more than 2% apart: no rate, 503. One up: its rate, named in `rate_source`; open.er-api.com only while under 26 h old. Coinbase's own USDC table isn't used: for some currencies it is a local crypto price (USDC→INR was 6.8% above the rupee's mid-market rate on 2026-10-17).
  - USDC = amount ÷ rate, rounded **up** to 6 decimals, exact bigint arithmetic in `fiat.ts` (one file, copied byte for byte to `plugin/src/` and `web/lib/`). Splits are planned in the currency's minor units, then each share is locked at one rate; invoice lines are priced in the currency and their total is locked.
  - The id still commits to the USDC amount only, so pay_link's tamper check (it recomputes the id from what the server returns) is unchanged. The quote (`fiat`: currency, amount, rate, rate_source, quoted_at) is display only, but every reader recomputes it: the creating tool and `pay_link` refuse a quote that doesn't round up to exactly the USDC amount, and pages, `check_payments`, `who_owes_me` and `write_reminder` show only a quote that does, labelled as a quote. A local-currency ask has no offline link (only the server can lock a rate), and `ask_every_month` refuses `currency` (a rate locked today would be wrong next month).
- **SNS names point where they say, at payment time.** `ask_for_money` resolves `name.sns` on Solana (SNS-IP 5: the name's SOL record v2, else its owner), screens the wallet and sends `sns_name`; the server re-resolves it and stores the name only if it points to the recipient right then. The pay page re-resolves it on every render and says "verified on-chain" only while it still matches; `pay_link` re-resolves it before proposing and refuses a name that moved. `.sol` is refused (SNS moved its names to `.sns` in August 2026 and its SDK refuses `.sol` from slot 452,825,395), and so are tokenized names (both public RPC hosts refuse the call needed to find their holder) and names with lookalike characters. The resolver core is one block, byte-identical in `plugin/src/sns.ts` and `web/lib/sns.ts`, tested against 19 real mainnet names.
- **Sanctions.** Recipients on the U.S. Treasury's OFAC SDN list (Solana and EVM addresses, a dated local snapshot) are refused by the plugin, with no network, and by every create route on the server (403 `blocked`).
- **Untrusted text stays untrusted.** Requester-written text reaches the payer's agent only as quoted, cleaned text, with a caution line when it mentions a brand.

## Tests

[docs/TESTING.md](TESTING.md) lists every layer with exact commands: plugin and web unit tests on recorded mainnet and DNS answers, Postgres tests on PGlite, contract fixtures that both sides parse, the MCP harness that runs the bundle as PayBox does and decodes every proposed transaction, and smoke checks against production.
