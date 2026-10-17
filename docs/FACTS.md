# Facts

Every number or claim in the README, landing page and submission comes from this file. Each line says how it was verified.

## Deployments
- Web: https://owed-omega.vercel.app (Vercel project `owed`, root `web`, first production deploy 2026-10-17 00:15 EDT, verified HTTP 200 with the one-liner).
- Plugin: transaction-layout test build uploaded to the PayBox developer portal 2026-10-17 00:30 EDT; hosted checks passed (2 tools). Not submitted.
- Plugin: build of `main` ed9623b (dist/plugin.mjs, 1,052,829 bytes, sha256 `2100bdbe4ed1f356976445ba4eadafc967ceb1a799f7333071e2b17f01ccd560`, same digest as CI) uploaded to the PayBox developer portal 2026-10-17 01:52 EDT. Hosted checks passed, 3 tools. Network access: owed-omega.vercel.app, solana-rpc.publicnode.com, api.mainnet-beta.solana.com. Variable OWED_BASE_URL=https://owed-omega.vercel.app. Not submitted.
- Web production: ed9623b at https://owed-omega.vercel.app; `smoke.mjs --strict --create` 22 pass, 0 fail (2026-10-17 01:40 EDT, request `1RRer81ufk`).

## Database
- Neon Postgres via the Vercel integration: `owed-db` serves Production, `owed-db-preview` serves Preview and Development, so previews and smoke runs never write production rows. Migration `0001_core` applied to both on 2026-10-17 (04:45Z and 04:49Z), recorded by `web/scripts/migrate.sh --status`.

## Solana mainnet behaviour (observed 2026-10-17)
- Mainnet carries version-1 transactions (solana-core 4.3.0, about 10% of transactions in sampled blocks). `getTransaction` and `getBlock` with `maxSupportedTransactionVersion: 0` fail with -32015, so plugin and web both request version 1. Verified by W1-B's block sampling and the recorded fixtures in `plugin/test/fixtures/chain/`.
- Rent is below the textbook constants: the team wallet's new USDC account holds 1,488,440 lamports, and `getMinimumBalanceForRentExemption(0)` returns 650,240. Neither is hard-coded; the 0.003 SOL fee reserve in `tx.ts` covers account creation plus fees.
- Team wallet `FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs` held 0.05 SOL and 5 USDC at 00:47 EDT (read through `chain.ts` against mainnet).

## Mainnet transactions
(none yet)

## PayBox validation spike
- Variant A (ATA-create-idempotent + memo + transferChecked + 1 reference): 399 bytes; portal Test run succeeded and returned a valid proposal. Validate transaction with sol-default: "Validation failed: the proposal could not be simulated or prepared" while the wallet held 0 SOL and 0 USDC. Re-run after funding to separate format from funds.
- Variants B, C, D: not needed. The real `pay_link` (variant A) passes Validate with the funded wallet, below.

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
