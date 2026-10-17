# Facts

Every number or claim in the README, landing page and submission comes from this file. Each line says how it was verified.

## Deployments
- Web: https://owed-omega.vercel.app (Vercel project `owed`, root `web`, first production deploy 2026-10-17 00:15 EDT, verified HTTP 200 with the one-liner).
- Plugin: transaction-layout test build uploaded to the PayBox developer portal 2026-10-17 00:30 EDT; hosted checks passed (2 tools). Not submitted.

## Mainnet transactions
(none yet)

## PayBox validation spike
- Variant A (ATA-create-idempotent + memo + transferChecked + 1 reference): 399 bytes; portal Test run succeeded and returned a valid proposal. Validate transaction with sol-default: "Validation failed: the proposal could not be simulated or prepared" while the wallet held 0 SOL and 0 USDC. Re-run after funding to separate format from funds.
- Variants B, C, D: pending funding.

## Build notes
- The plugin bundle uses `--main-fields=module,main` and a `createRequire` banner so CommonJS parts of @solana/web3.js and @solana/spl-token can load Node builtins inside the ESM bundle. Without it the bundle crashes at startup ("Dynamic require of buffer is not supported").

## Dependency pins
- plugin: @solana/web3.js 1.98.4, @solana/spl-token 0.4.14, bs58 6.0.0 (exact, published ≥2 weeks before Oct 17 2026)
- web: next 16.3.8, @supabase/supabase-js 2.117.2, qrcode 1.5.4, zod 4.4.3, tweetnacl 1.0.3
