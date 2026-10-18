# Testing

Toolchain: `export PATH=$HOME/.local/owed-bin:/opt/homebrew/opt/node@24/bin:$PATH` (Node 24, pnpm 11.11.0).
Install once per package: `(cd plugin && pnpm install --frozen-lockfile)`, `(cd web && pnpm install --frozen-lockfile)`.
Everything else below has no extra dependencies. Tests use doubles only inside tests; production code paths never do.

| Layer | Command (repo root) | Proves | CI |
|---|---|---|---|
| Plugin unit | `(cd plugin && pnpm unit)` | money, Solana Pay, tx, chain, tools logic (`plugin/test/*.test.ts`) | `plugin` |
| Plugin gate | `(cd plugin && pnpm test)` | typecheck, byte-identical double build, starter conformance on the sample call | `plugin` |
| Contract | `node contract/check.mjs` then `node contract/run-tests.mjs [--strict]` | fixtures are self-consistent; `plugin/src/contract.ts` and `web/lib/contract.ts` both parse every fixture | `contract` |
| Web | `(cd web && pnpm lint && pnpm run --if-present test && pnpm build)` | lint, web unit tests, production build | `web` |
| Tooling | `node --test "e2e/test/*.test.mjs"` | the shapes, tx decoder, smoke grading and e2e harness themselves | `plugin` |
| MCP e2e | `node e2e/plugin-e2e.mjs plugin/dist/plugin.mjs [tool] [json-args] [--sample]` | the bundle as PayBox runs it: fresh process per call, clean env, 10 s, 256 KiB stdout, schemas, network rules, decoded proposal | `plugin` (sample on the configured hosts, then with every host down) |
| Remote MCP | `(cd web && pnpm test)` (`web/test/mcp-*.test.ts`); `node scripts/check-mcp-bundle.mjs` after a plugin build | `POST /api/mcp`: JSON-RPC parsing, batches, notifications (202), 405/413/429, version negotiation and 2026-07-28 header checks; the real committed bundle offline (tools/list, check_payments, pay_link's proposal identical to the bundle's own); `web/mcp/owed-plugin.mjs` equals `plugin/dist/plugin.mjs` | `web` (tests), `plugin` (bundle check) |
| Smoke | `node web/scripts/smoke.mjs https://owed-omega.vercel.app [--strict] [--create \| --id <id>]` | every Tier-1 route and page on a live deployment, JSON shapes from `contract/shapes.mjs` | `smoke.yml` after each production deploy |
| Golden path | `e2e/golden-path.md` | SPEC §7 rows 1, 5, 7, 8 on mainnet before the portal upload | manual (LEAD) |

## Remote MCP bundle

- `node scripts/sync-mcp-bundle.mjs` builds the plugin (`cd plugin && pnpm run build`) and copies `plugin/dist/plugin.mjs` to `web/mcp/owed-plugin.mjs`, then writes `web/mcp/owed-plugin.meta.json` (sha256, size, protocol version, server version and tool names, read from the bundle with one offline `tools/list`; no timestamps). `--no-build` copies the current build; `--from <file>` copies another one (a CI artifact).
- `node scripts/check-mcp-bundle.mjs [--built <file>]` exits 1 when the copy or its meta file no longer matches the build (fix: re-run the sync and commit `web/mcp/`), 2 when there is no build to compare with.
- Run the sync in every sprint that changes `plugin/`, in the same commit.

## MCP e2e harness

- No tool: lists tools only. `--sample` calls `plugin/paybox-plugin.json`. Arguments can be `@file.json`.
- Network: discovery runs with none (PayBox forbids network at startup and in `tools/list`). A call may reach the
  Owed host plus `solana-rpc.publicnode.com`, `api.mainnet-beta.solana.com`, `cloudflare-dns.com` and `dns.google`
  (verified payee's DNS-over-HTTPS) over HTTPS:443; override with
  `--hosts a,b`, `--hosts none`, `--hosts any` or `--no-guard`. Every attempt is printed; blocked ones fail the run.
  `--down host` refuses a host as a simulated outage without failing (golden-path row 8).
- Brokered secrets: `--broker <host>:<Header>=@<file>` adds the header to the plugin's HTTPS fetches to that exact host,
  as PayBox does with a portal Secret. The value is read from the file inside the network guard: it never reaches the
  plugin's env or argv, or the report. The run fails if the tool's output contains it. (Owed uses no brokered secret.)
- Startup health: at the plugin's first response the harness checks that `new Error().stack` still works. A bundled
  CommonJS dependency that breaks it (`__filename is not defined`) would crash every later error path.
- Assertions: `--expect results.0.status=paid` (structuredContent), `--expect proposal.transfer.amount=1` (decoded
  tx), `--expect-text`, `--expect-error` / `--allow-error`, `--expect-no-proposal`, `--max-ms`.
- Scripting: `--print link` writes one field to stdout (report on stderr); `--json` writes the whole report.
- `pay_link` proposals are decoded and checked against what is being paid (the `solana:` URL, or
  `GET /api/v1/requests/<id>` for Owed links): fee payer, size, legacy format, amount, mint, recipient account,
  references read-only, memo.
- `pay_all` proposals are decoded with every request's terms from `GET /api/v1/requests?ids=`: each transfer must carry
  exactly one request's references and pay exactly its terms, and the memo must name every request.

## Local-currency asks

- `plugin/test/local_currency.test.ts`: `fiat.ts` math (minor units, zero-decimal currencies, rounding up, 2% rule, display) and every tool's `currency` path against the `fiat.*` contract fixtures and a stand-in server.
- `web/test/fiat.test.ts`: the two `fiat.ts` copies are identical; `lib/fx.ts` reads exact decimals from real captured replies (`web/test/fixtures/fx/`, 2026-10-17T21:06:41Z) and locks, cross-checks, falls back or refuses.
- `web/test/fiat-db.test.ts`: migration 0013 on PGlite, then `/requests`, `/groups`, `/invoices`, `/status`, `/schedules`, the ledger, the CSV and the page models with `currency`.
- `node --test e2e/test/fiat-shapes.test.mjs`: `contract/shapes.mjs` rejects a quote that doesn't give its USDC.
- Against a local server: `next start` with a `NODE_OPTIONS=--import` preload that answers the Neon SQL-over-HTTP calls from an in-memory PGlite (all migrations), behind an HTTPS proxy on a throwaway CA; then `node e2e/plugin-e2e.mjs plugin/dist/plugin.mjs ask_for_money '{"recipient":…,"amount":"1200","currency":"INR"}' --base-url https://localhost:<port> --env NODE_EXTRA_CA_CERTS=<ca.pem> --hosts any` (the guard only allows port 443, so `--hosts any`; its report still lists every connection).

## Payer inbox and pay_all (F1)

- `plugin/test/payer.test.ts`: handles (optional `@`, lower case, 1 to 15 characters), `{handle, wallet}` kept as a label, `{sns}` resolved on Solana, refusals (the recipient as payer, a token account, a handle without its wallet), the handle-check line, and `ask_for_money` refusing a reply that didn't store the payer.
- `plugin/test/what_do_i_owe.test.ts`: both calls against the contract fixtures (a real ed25519 signature): the message to sign, the inbox with unverified labels, first-time marks, Base apart, cautions kept out of `pay_all_ids`, local refusals (stale, future, wrong wording, wrong signer), and block.
- `plugin/test/pay_all.test.ts`: two same-amount USDC requests to one recipient plus a SOL one in one transaction, a missing USDC account opened once, `max_total` and balance refusals, every skip reason (SOL without `max_total_sol`, Base, paid, tampered, unknown, own, cautioned, DNS), the handle check, chunking at 1,232 bytes, and the per-id fallback for a server without the bulk route.
- `plugin/test/batch_chain.test.ts`: the plugin's direct check pairs each reference with its own transfer (USDC, and SOL with the second read), `readBatchAccounts`, `assessBatch`, `buildBatchTx` and `planBatch`. `plugin/test/pay_link_f1.test.ts`: `pay_link`'s handle check and its note for a request addressed to another wallet.
- `web/test/pairing.test.ts`: paid detection on constructed multi-transfer transactions (USDC and SOL, the SOL second read, stored claims), plus the real mainnet captures, which pair the way the old rule credited them.
- `web/test/inbox-db.test.ts`: migration 0017 on PGlite, payer fields on every create route (requests, split shares, invoices, schedules), the signed inbox and block routes, bulk terms (`GET /requests?ids=`), the addressed-request limit, and two same-amount requests settled by one transaction.
- `node --test e2e/test/pay-all-tx.test.mjs e2e/test/inbox-shapes.test.mjs e2e/test/tool-list.test.mjs`: the decoder on a `pay_all` transaction built by the plugin's real batch builder, the inbox fixture shapes (signatures, totals, blocked requesters), and the bundle listing exactly the tools `plugin/src/tools/index.ts` registers (18 now: `tool-list.test.mjs` reads each module's `registerTool` name, so a sprint that registers a tool updates it).
- Contract fixtures for F1 are written by `node contract/inbox-fixtures.mjs` (deterministic: a fixed-seed ed25519 key signs the inbox and block messages).

## Funding plans (F2)

- `plugin/test/funding.test.ts`: Pyth decoding on a recorded account, price freshness and confidence-band rules, swap and buy sizing, every option per shortfall, `plan_id`, the text and its JSON.
- `plugin/test/pay_link_f2.test.ts` and `plugin/test/pay_all_f2.test.ts`: each spec case through the tools with the real `payerReadiness` / `readBatchAccounts` on captured mainnet accounts; refused requests never get a plan; `plan_id` recorded and echoed; a slow or refusing server.
- `web/test/plans-db.test.ts`: migration 0018 on PGlite, the three routes, the per-sender cap, "paid" read from the requests table.
- `node --test e2e/test/plan-shapes.test.mjs`: `contract/shapes.mjs` refuses unsafe plans.
- New chain fixtures: `cd plugin && node test/fixtures/capture.mjs readiness-usdc-sol-only-sender pyth-sol-usd` (a SOL-only sender; Pyth's SOL/USD account, base64).
- `contract/fixtures/funding-plan.*.json` and `plans.create.req.json` / `plans.used.req.json` are the plugin's own output: `cd plugin && OWED_WRITE_PLAN_FIXTURES=1 node --import tsx --test test/pay_link_f2.test.ts test/pay_all_f2.test.ts` rewrites them; without the variable the tests fail when they drift.
- Dry run of the real bundle, read-only, Owed host down: `node e2e/plugin-e2e.mjs plugin/dist/plugin.mjs pay_link '{"link":"solana:<team wallet>?amount=0.1&spl-token=<USDC>&reference=<any key>","sender":"ASTW3RMbeKoHaU5GUt8E1gXuRnE1gwJky1bLYQiZ4rEg"}' --expect-error --down owed-omega.vercel.app --expect-text "Funding plan (machine-readable):"` (about 1.1 s and 11.5 KiB, with a live Pyth price).

## Group ledgers (F6)

- `plugin/test/ledger_math.test.ts`: the shared arithmetic: decimal/units, `splitEvenly` parity, pro rata, every split mode and refusal, the 6-item receipt with tax and tip to the cent (leftovers like `splitEvenly`), 4 people / 5 expenses / 3 payers → 3 transfers that zero every balance once paid, cancelled and underpaid requests, 500 random ledgers (≤ n − 1 transfers, exact sums), digests, signed-message prefixes, `ledgerText` (links, domains, schemes dropped; idempotent), USDC→local display.
- `plugin/test/ledger_tools.test.ts`: the four tools against the contract fixtures: exact bodies, the message to sign, local refusals (wallet not in the ledger, unknown names, splits that don't add up, USD), stale/forged/changed signatures, a server that stored something else, a euro receipt's quote checked share by share, unverified balances shown with the plugin's own arithmetic, settle-up requests that don't pay the planned creditor, aren't addressed to the debtor, don't hash their terms or don't name the ledger, nothing to settle, nobody payable.
- `web/test/ledgers-db.test.ts`: migration 0020 on PGlite and the four routes end to end: create (owner first, payer identities, refusals), the acceptance ledger recorded by the owner and by members with their own wallets, write signatures (outsider 403, tampered body, another member's wallet, stale, single use), a euro receipt locked under the two-source rule (and refused at > 2%, signature not spent), settle-up (≤ 3 requests, each payable to the creditor, addressed to the debtor, id hashing its terms; lands in the debtor's `what_do_i_owe`), nothing to settle / stale version, paying them on chain zeroes every balance, unpayable creditors, cancelled requests putting debt back (not without the chain), brand flags on every settle-up request, DB constraints, and every reply's fields equal to its contract fixture's.
- `web/test/ledgers-math.test.ts`: the two math files are identical; the server's `prepareExpense` builds the fixtures' signed messages; `ledgerText` output is a fixed point of `sanitizeText`.
- `web/test/ledgers-page.test.ts`: the `/l/<id>` view model (directions, pending, quoted names, receipts, signatures checked, euro lines, titles that never echo flagged text).
- `node --test e2e/test/ledger-shapes.test.mjs`: `contract/shapes.mjs` re-derives ledgers with its own code (a third copy of the digest and the plan) and rejects tampered shares, quotes, balances, plans, signatures and settle-up requests.
- Contract fixtures for F6 (`contract/fixtures/ledgers.*.json`, plural like the route: `ledger.*` belongs to `who_owes_me`) are written by `node --import ./plugin/node_modules/tsx/dist/loader.mjs contract/ledger-fixtures.mjs` (deterministic: fixed-seed ed25519 keys sign every expense and settle-up; the arithmetic is the plugin's own).
- Against a local server (done once for SP6, not automated): `next start` with a `NODE_OPTIONS=--import` preload answering Neon from PGlite (all migrations), Solana RPC with empty histories and the FX hosts from `web/test/fixtures/fx/`, behind an HTTPS proxy on a throwaway cert; the real bundle ran start_ledger → 5 × add_expense (two calls each, one in EUR) → ledger_balances (verified) → settle_up (3 requests) → settle_up again ("nothing") → check_payments on the 3 ids, every call through `e2e/plugin-e2e.mjs` with `--hosts any`.

## Invoice terms, refunds, statements (F8)

- `web/test/invoice-terms.test.ts`: the core (`invoice-terms-core.ts`) is byte-identical in plugin and web; installments, discounts, fees, chase stages, percent parsing; refund rules and ids; statement arithmetic; the invoice page model.
- `web/test/invoice-terms-db.test.ts`: migration 0021 on PGlite (tables, trigger, loosened cancel check); a 3-installment invoice opens three requests on the right days (concurrent cron runs open each once) and shows paid only when all are; an early price paid through a chain read skips the full price; paying the full price cancels the early one and a late early payment cancels the full one; a chain outage makes the full price wait; local-currency prices; the late fee once (unpaid, paid late), never (paid on time, cancelled); the cron route; chase tones; the ledger route's composition (`withInvoiceTerms(withSchedules(getLedger))`); the `/r` notes.
- `web/test/refunds-db.test.ts`: partial and full refunds, the cap (checked before the signature is spent), refusals, SOL, confirmation only by the recipient's transfer, one transfer confirms one refund, lapsing, outage, invoice and `/r` notes.
- `web/test/statements-db.test.ts`: a client's month (opening, lines, closing), CSV and links, wallet clients, signature rules, credits.
- `plugin/test/refund_payment.test.ts`, `invoice_terms.test.ts`, `who_owes_me_f8.test.ts`, `match_payments_f8.test.ts`, `check_payments_f8.test.ts`: every proposal decoded (fee payer, transfer to the payer, reference read-only, memo), the terms planned locally and a reply that differs refused, reminders due, overpayments, refunds.
- The 9 F8 fixtures (`contract/fixtures/invoice.terms.*`, `invoice.statement.res.json`, `refund.*`, `refunds.lookup.res.json`) were produced by the real routes on PGlite; both contract tests also check that every older invoice and ledger fixture parses with the terms-aware schemas.

## Fixtures

- Solana: `cd plugin && node test/fixtures/capture.mjs [case…]` re-records mainnet JSON-RPC exchanges; tests replay them
  and fail on any unrecorded call.
- DNS (verified payee): `cd plugin && node test/fixtures/capture-doh.mjs [case…]` re-records both resolvers' DoH JSON
  answers into `plugin/test/fixtures/doh/`. `OWED_CAPTURE_DOMAIN=<domain> node test/fixtures/capture-doh.mjs published-record`
  records a live `_owed` TXT record; it refuses to write unless both resolvers return an `owed-pay=` record. The web
  suite (`web/test/payee*.test.ts`) runs the same fixtures and `plugin/test/fixtures/payee-vectors.json`.
- SNS names (W3-S): `cd plugin && node --import tsx test/fixtures/capture-sns.mjs [case…]` re-records the mainnet accounts
  `src/sns.ts` reads for each name into `plugin/test/fixtures/sns/`, with what SNS's own SDK returns for it. Both
  `plugin/test/sns.test.ts` and `web/test/sns.test.ts` replay them, and the web test also checks that `web/lib/sns.ts`'s core is
  the plugin's, byte for byte. `web/test/sns-db.test.ts` runs migration 0015 and the request routes on PGlite.
- Sanctions list: `cd web && node scripts/ofac-sdn.mjs [sdn.xml]` rebuilds `plugin/src/ofac-sdn.ts` and `web/lib/ofac-sdn.ts`
  from the U.S. Treasury's OFAC SDN list (Solana and EVM digital currency addresses, with the list's publish date).
  Re-run it before a release; `web/test/sanctions.test.ts` checks both copies are identical.
- Pay with PayBox (SP1): `web/test/cta-db.test.ts` runs migration 0016 on PGlite, the counting redirect, the prompt-copy POST and `/api/v1/stats`; `web/test/cta-view.test.ts` checks when the pay page shows the section, its exact prompt, and the `OWED_PAYBOX_CTA` switch.
- Migrations on the build: `web/test/migrate-on-build.test.ts` (19 tests) checks when `web/scripts/migrate-on-build.mjs` runs (Vercel production and preview with a database URL; never locally, in GitHub CI or for Development), the node-postgres options (verified TLS unless `sslmode=disable`, Neon pooler host to direct, decoded credentials), redaction of the URL and password, and, on PGlite: every real file in `web/db/migrations` applied in order to an empty database and recorded; a second run applies nothing; only the files `migrate.sh` hasn't recorded are applied; multi-statement files with comments and DO blocks; a failing or mistyped file rolls back completely (no table, no `schema_migrations` row), stops the run and is named; the advisory lock is released after success and failure. The CLI runs as a child process only where it can't reach a database (skips, and a refused port on 127.0.0.1 that exits 1 without printing the password).
- Postgres: `web/test/x402-store.test.ts`, `web/test/payee-db.test.ts`, `web/test/inbox-db.test.ts`, `web/test/plans-db.test.ts`, `web/test/ledgers-db.test.ts`, `web/test/invoice-terms-db.test.ts`, `web/test/refunds-db.test.ts` and `web/test/statements-db.test.ts` run the migrations and SQL on PGlite and skip
  until the devDependency `@electric-sql/pglite` is installed.

## Smoke

- Pending vs failing: a route Vercel answers with `x-matched-path: /404` is not deployed yet and shows as `PEND`.
  `--strict` turns those into failures (use it from L2 on; set repo variable `SMOKE_STRICT=1` for CI).
- Read-only by default. `--create` writes exactly one real request: 0.01 USDC to the team wallet, `source: "web"`, requester "Owed smoke",
  with a URL and a control character in the requester text and "PayBox" in the note, then checks they were
  stripped/flagged and that the QR, pay page and preview image serve. `--id <id>` runs the same reads on an
  existing request. `--page <path|url>` adds a page that must return 200 HTML. `--json` for machines.
- Every route family gets a read-only check, including funding plans (`GET /api/v1/plans/stats`), group ledgers (an unknown and a malformed id, a create refused for a token-account owner, the `/l/<id>` page's 404) and refunds (an unknown id). `e2e/test/smoke.test.mjs` grades the script against a local double of the app: nothing deployed (2 pass, 19 pending), fully deployed with `--strict --create` (all pass), `--id`, and regressions.
- Exit codes: 0 ok, 1 a check failed, 2 the smoke itself could not run.
