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
| Smoke | `node web/scripts/smoke.mjs https://owed-omega.vercel.app [--strict] [--create \| --id <id>]` | every Tier-1 route and page on a live deployment, JSON shapes from `contract/shapes.mjs` | `smoke.yml` after each production deploy |
| Golden path | `e2e/golden-path.md` | SPEC §7 rows 1, 5, 7, 8 on mainnet before the portal upload | manual (LEAD) |

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

## Local-currency asks

- `plugin/test/local_currency.test.ts`: `fiat.ts` math (minor units, zero-decimal currencies, rounding up, 2% rule, display) and every tool's `currency` path against the `fiat.*` contract fixtures and a stand-in server.
- `web/test/fiat.test.ts`: the two `fiat.ts` copies are identical; `lib/fx.ts` reads exact decimals from real captured replies (`web/test/fixtures/fx/`, 2026-10-17T21:06:41Z) and locks, cross-checks, falls back or refuses.
- `web/test/fiat-db.test.ts`: migration 0013 on PGlite, then `/requests`, `/groups`, `/invoices`, `/status`, `/schedules`, the ledger, the CSV and the page models with `currency`.
- `node --test e2e/test/fiat-shapes.test.mjs`: `contract/shapes.mjs` rejects a quote that doesn't give its USDC.
- Against a local server: `next start` with a `NODE_OPTIONS=--import` preload that answers the Neon SQL-over-HTTP calls from an in-memory PGlite (all migrations), behind an HTTPS proxy on a throwaway CA; then `node e2e/plugin-e2e.mjs plugin/dist/plugin.mjs ask_for_money '{"recipient":…,"amount":"1200","currency":"INR"}' --base-url https://localhost:<port> --env NODE_EXTRA_CA_CERTS=<ca.pem> --hosts any` (the guard only allows port 443, so `--hosts any`; its report still lists every connection).

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
- Postgres: `web/test/x402-store.test.ts` and `web/test/payee-db.test.ts` run the migrations and SQL on PGlite and skip
  until the devDependency `@electric-sql/pglite` is installed.

## Smoke

- Pending vs failing: a route Vercel answers with `x-matched-path: /404` is not deployed yet and shows as `PEND`.
  `--strict` turns those into failures (use it from L2 on; set repo variable `SMOKE_STRICT=1` for CI).
- Read-only by default. `--create` writes exactly one real request: 0.01 USDC to the team wallet, `source: "web"`, requester "Owed smoke",
  with a URL and a control character in the requester text and "PayBox" in the note, then checks they were
  stripped/flagged and that the QR, pay page and preview image serve. `--id <id>` runs the same reads on an
  existing request. `--page <path|url>` adds a page that must return 200 HTML. `--json` for machines.
- Exit codes: 0 ok, 1 a check failed, 2 the smoke itself could not run.
