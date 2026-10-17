# Facts

Every number or claim in the README, landing page and submission comes from this file. Each line says how it was verified.

## Deployments
- Web: https://owed-omega.vercel.app (Vercel project `owed`, root `web`, first production deploy 2026-10-17 00:15 EDT, verified HTTP 200 with the one-liner).
- Plugin: transaction-layout test build uploaded to the PayBox developer portal 2026-10-17 00:30 EDT; hosted checks passed (2 tools). Not submitted.
- Plugin: build of `main` ed9623b (dist/plugin.mjs, 1,052,829 bytes, sha256 `2100bdbe4ed1f356976445ba4eadafc967ceb1a799f7333071e2b17f01ccd560`, same digest as CI) uploaded to the PayBox developer portal 2026-10-17 01:52 EDT. Hosted checks passed, 3 tools. Network access: owed-omega.vercel.app, solana-rpc.publicnode.com, api.mainnet-beta.solana.com. Variable OWED_BASE_URL=https://owed-omega.vercel.app. Not submitted.
- Plugin: build of `main` 9c93ee8 (dist/plugin.mjs, 1,053,764 bytes, sha256 `019eda0fe05488e5a6e37c84ed918f5ef633ba5f38a27f3549c2e82574722474`) uploaded 2026-10-17 02:10 EDT, replacing ed9623b. Hosted checks passed, 3 tools. Not submitted.
- Web production: ed9623b at https://owed-omega.vercel.app; `smoke.mjs --strict --create` 22 pass, 0 fail (2026-10-17 01:40 EDT, request `1RRer81ufk`).
- Web production: main 758ba4c (wave 2: split bills, invoices, x402 rail, verified payee) live 2026-10-17 07:18 EDT, deployment `dpl_29do7nuh5rLaCBEK3A26Ai97YUD8`; CI run 39028117706 green (plugin, web, contract). `smoke.mjs --strict --create` 23 pass, 0 fail (request `nsxnm39fhvoR`).
- Domain: https://www.getowed.xyz serves the same production deployment (`/api/v1/stats` 200); https://getowed.xyz answers 308 to it. Registered at Porkbun; `_owed.getowed.xyz` TXT `owed-pay=FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs` read through dns.google. Since the 08:36 EDT production redeploy, Vercel's OWED_BASE_URL is https://www.getowed.xyz, so new links are on it; owed-omega.vercel.app keeps serving the same deployment and older links.
- Plugin: build of main 758ba4c (dist/plugin.mjs, 1,096,747 bytes, sha256 `ff140f6ccafadd175dad8b73292087462eb6d08c74a856897f082bab8c9b1960`, `pnpm test` passed, 6 tools: ask_for_money, check_payments, pay_link, verify_payee, split_bill, create_invoice). Uploaded to the PayBox developer portal 2026-10-17 08:30 EDT, replacing 9c93ee8: checks passed, 6 tools. Network access: api.mainnet-beta.solana.com, cloudflare-dns.com, dns.google, owed-omega.vercel.app, solana-rpc.publicnode.com, www.getowed.xyz. Variable OWED_BASE_URL=https://www.getowed.xyz. Not submitted.
- Plugin: build of main bbabd54 (QA-02 fix: a verified domain that spells a brand or embeds another domain gets a caution; dist/plugin.mjs 1,099,739 bytes, sha256 `aa8091d8f4b68b099cfb233700399688cd1d03d88039a6e69d2636c9c74ee0fb`, CI green) uploaded to the portal 2026-10-17 09:33 EDT, replacing 758ba4c; checks passed, 6 tools. Portal Test console: `verify_payee {domain: getowed.xyz.paybox-support.com}` → not verified, plus "looks like PayBox but isn't PayBox's domain (paybox.sh)", "looks like Owed but isn't Owed's domain" and "only starts with \"getowed.xyz\"" (4,073 ms). Production smoke `--strict` 15 pass, 0 fail.
- Web production: main f765e3e (W2-F landing v2, /proof, brand, llms.txt; QA-12 bidi isolation) live 2026-10-17 11:25 EDT, deployment `dpl_4wiUk5sgHmuWxQa1N7HQCdxm818s`, CI green. `OWED_TEAM_WALLETS` (Production and Preview) = the team wallet FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs, set before that deploy. Smoke `--strict` 15 pass, 0 fail; `/`, `/proof` and `/llms.txt` answer 200. No plugin change (bundle still `aa8091d8…`).
- Web production: main e2108b6 (W2-D ledger + reminders, W2-E QA-01/QA-06, W2-H QA-05/10/21, W2-F QA-19/QA-17, README/ARCHITECTURE) and 42a40d3 (W3-A Helius webhook) live 2026-10-17 12:15–12:20 EDT, CI green on both. Production migration `0005_ledger_nonces` applied 16:13Z after a `begin … rollback` dry run.
- Plugin: build of main 42a40d3 (dist/plugin.mjs 1,131,778 bytes, sha256 `53a0e8680e8a62b583efb33a7d566a7aadac8ec45c67bc05c2485c8d495efc49`) uploaded to the portal 2026-10-17 12:26 EDT, replacing bbabd54; checks passed, **8 tools**: ask_for_money, check_payments, pay_link, verify_payee, split_bill, create_invoice, who_owes_me, write_reminder. Hosts and variables unchanged. Not submitted.
- Plugin: build of main 79a06eb (dist/plugin.mjs 1,196,724 bytes, sha256 `2ca892090d9a71904a39e5d0060d3a129b86d7df7d0a248c1a0b1950e86e07eb`; e2e tool list and sample call PASS) uploaded to the PayBox developer portal 2026-10-17 13:31 EDT, replacing 42a40d3. Checks passed, **10 tools**; the portal Test console loads ask_for_money, check_payments, pay_link, verify_payee, split_bill, create_invoice, write_reminder, who_owes_me, cancel_request, ask_every_month (3,623 ms). Hosts and variables unchanged. Not submitted.
- Sanctions screen (main 79a06eb): the plugin and the server's create routes refuse recipients on the U.S. Treasury's OFAC SDN list (local snapshot of the list published 2026-10-15: 4 Solana and 124 EVM digital-currency addresses). The plugin's check uses no network; the server answers 403 `blocked`.

## Database
- Neon Postgres via the Vercel integration: `owed-db` serves Production, `owed-db-preview` serves Preview and Development, so previews and smoke runs never write production rows. Migration `0001_core` applied to both on 2026-10-17 (04:45Z and 04:49Z), recorded by `web/scripts/migrate.sh --status`.
- Migrations `0002_groups`, `0003_invoices`, `0004_x402_receipts`, `0009_payee_domain` applied to `owed-db` (production) 2026-10-17 11:16Z, after the four ran inside `begin … rollback` on its 4 existing rows. `owed-db-preview` had them from 10:07Z to 10:34Z.

## Wave 2 on production (main 758ba4c, 2026-10-17 07:20 EDT, nothing paid yet)
- Split bill: `check-groups.ts --create --allow-production` all checks passed; group `GuRPADHGLGiu`, 3 × 0.5 USDC to the team wallet, board "0 of 3 paid".
- Invoice: `check-invoices.ts --create --allow-production` all checks passed; invoice `SuVNtmmeBt9b`, 3 lines, 1 USDC, due 2026-10-24, printable page and preview card served.
- x402: `GET /x/nsxnm39fhvoR` → 402 whose v2 challenge pays 10000 atomic USDC (`EPjFWdd5…Dt1v`) to the team wallet on `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. No x402 payment settled on mainnet yet.
- Verified payee: `POST /api/v1/requests` with `from_domain: getowed.xyz` → 201 `3sUaVYuB3nzV`, stored `from_domain_verified_at` 2026-10-17T11:19:12Z, pay page shows "From getowed.xyz · verified just now". The same domain for a wallet it doesn't publish → 400 naming the TXT record to add.

## PayBox portal test console (2026-10-17 08:38 EDT, build 758ba4c)
- `verify_payee {link: https://www.getowed.xyz/r/3sUaVYuB3nzV}` → "Verified: getowed.xyz publishes this wallet (FN6G…cbvs) in its DNS (not DNSSEC-signed).", `records: 1`, 3,869 ms total.
- `ask_for_money` (0.01 USDC to the team wallet, `from_domain: getowed.xyz`) → hosted `x3oG8Zsgj8Xw`, link https://www.getowed.xyz/r/x3oG8Zsgj8Xw, "From getowed.xyz: verified", 4,340 ms total. The API and the pay page agree ("From getowed.xyz · verified just now").

## Tokens and payment layout (read-only, 2026-10-17 12:40 EDT, main 272a658, bundle sha256 `58d8608270178605…`)
Each line ran the real bundle through `e2e/plugin-e2e.mjs` (fresh process, 10 s, exact-host network rules) against production with `OWED_BASE_URL=https://www.getowed.xyz`; the harness decodes every proposed transaction and checks it against the link it pays. Nothing was signed or sent.
- **USDC or SOL.** `check_payments` on a real mainnet SOL Solana Pay payment (reference `5Q23XrMHYQz9YFiZd3hSW4PveFJLoj2VvNC2SXa2csbV`, one system transfer of 3,027,000 lamports to `96gYZ…rZU5`, the payment W1-B recorded in `plugin/test/fixtures/chain/sol-reference-payment.json`) → "1 of 1 paid · 0.003027 SOL received", signature `3XgKY2pjaX4WjV23Fcav1xpQVXWKUQCgbh6RC6abDqP5Tid28LdcUmyarG2jzPPSwHrMuuBr1Ch6Gwn2oCcpaswE`. `pay_link` on a 0.001 SOL transfer link to the team wallet → a 248-byte proposal with one instruction: a system transfer of 1,000,000 lamports to `FN6G…cbvs`, with the link's reference as a read-only key. USDC: see the next line.
- **No fee, no Owed account in the transaction.** `pay_link` on the production request `3sUaVYuB3nzV` (0.01 USDC) → a 364-byte proposal: a memo `owed:3sUaVYuB3nzV` and one `transferChecked` of 10,000 atomic USDC into the recipient's USDC account `2YXy…gv1x`, fee payer = the payer, the request's reference read-only. When the recipient has no USDC account yet, the proposal adds an idempotent create of that account, paid by the payer (FACTS, build ed9623b test console). No instruction in any decoded proposal sends anything to Owed.

## Solana mainnet behaviour (observed 2026-10-17)
- Mainnet carries version-1 transactions (solana-core 4.3.0, about 10% of transactions in sampled blocks). `getTransaction` and `getBlock` with `maxSupportedTransactionVersion: 0` fail with -32015, so plugin and web both request version 1. Verified by W1-B's block sampling and the recorded fixtures in `plugin/test/fixtures/chain/`.
- Rent is below the textbook constants: the team wallet's new USDC account holds 1,488,440 lamports, and `getMinimumBalanceForRentExemption(0)` returns 650,240. Neither is hard-coded; the 0.003 SOL fee reserve in `tx.ts` covers account creation plus fees.
- Team wallet `FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs` held 0.05 SOL and 5 USDC at 00:47 EDT (read through `chain.ts` against mainnet).

## Mainnet transactions
(none yet)

## PayBox validation spike
- Variant A (ATA-create-idempotent + memo + transferChecked + 1 reference): 399 bytes; portal Test run succeeded and returned a valid proposal. Validate transaction with sol-default: "Validation failed: the proposal could not be simulated or prepared" while the wallet held 0 SOL and 0 USDC. Re-run after funding to separate format from funds.
- Variants B, C, D: not needed. The real `pay_link` (variant A) passes Validate with the funded wallet, below.

## Request ids commit to the payment terms (from main 9c93ee8)
- A request id is the last 12 base58 characters of sha256 over `owed-request:v1`, recipient, asset (USDC mint or SOL), atomic amount and reference (`plugin/src/request-id.ts`, `web/lib/ids.ts`, same test vector `JArQ6g9JvoWr` on both sides).
- `pay_link` recomputes the id from what the server returns and refuses on a mismatch, so the server can't change who gets paid or how much behind a shared link. Unit test: a server returning an internally consistent swapped recipient, amount or reference is refused; with the check disabled that test fails.
- `ask_for_money` refuses a hosted link whose id doesn't hash its terms. Older random 10-character ids stay readable; `pay_link` refuses them.
- Production: migration `0001a_derived_ids` applied to both databases 2026-10-17 05:57Z. `smoke.mjs --strict --create` 23 pass, 0 fail; the smoke contract checks every 12-char id it sees (request `qS77tLgiuG7N`).
- Portal, build 9c93ee8: `ask_for_money` → hosted `2eakA8uYr4Qd` (4,358 ms); `pay_link` on it from sol-default → proposal (3,534 ms); Validate with sol-default: "Simulation passed"; `pay_link` on the older link `1RRer81ufk` → refused, "This is an older Owed link whose payment details can't be checked against its id…".

## PayBox portal test console (2026-10-17, build ed9623b)
- `ask_for_money` (0.01 USDC to the team wallet): hosted request `ux9oshckE4` created inside the PayBox sandbox, 4,353 ms total.
- `check_payments` on `ux9oshckE4` and `1RRer81ufk`: both open, "0 of 2 paid", 3,956 ms total.
- `pay_link` on a raw Solana Pay link for 0.01 USDC to a never-used address (sender sol-default): proposal returned, 4,819 ms total. It creates the recipient's USDC account, attaches the memo, sends USDC with the reference as a read-only key.
- Validate transaction on that proposal with sol-default: "Simulation passed" (simulation only; nothing signed or broadcast).
- `pay_link` on a request that pays the sender's own wallet is refused: "This request pays your own wallet, so there is nothing to send."

## Build notes
- The plugin bundle uses `--main-fields=module,main` and a `createRequire` banner so CommonJS parts of @solana/web3.js and @solana/spl-token can load Node builtins inside the ESM bundle. Without it the bundle crashes at startup ("Dynamic require of buffer is not supported").

## Dependency pins
- plugin: @solana/web3.js 1.98.4, @solana/spl-token 0.4.14, bs58 6.0.0 (exact, published ≥2 weeks before Oct 17 2026)
- web: next 16.3.8, react 19.2.8, @solana/web3.js 1.98.4, @solana/spl-token 0.4.14, bs58 6.0.0, qrcode 1.5.4, zod 4.4.3, tweetnacl 1.0.3
