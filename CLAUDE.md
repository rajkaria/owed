# Owed — repo guide for coding agents

Owed is a PayBox plugin that lets your agent ask anyone for money, then tells you who has paid. Everything runs on Solana mainnet with real funds: no demo mode, no staged data, no mocks in production paths.

## Layout
- `plugin/` PayBox plugin (TypeScript MCP server over stdio → `dist/plugin.mjs`). Built from PayBox starter v1.0.2. `src/paybox.ts` is the starter's helper file: never edit it.
- `web/` Next.js 16 app on Vercel: pay pages + `/api/v1` JSON API + Postgres.
- `contract/fixtures/` canonical API examples. `plugin/src/contract.ts` and `web/lib/contract.ts` must both parse every file.
- `docs/FACTS.md` the only source for numbers and claims.

## Toolchain
```
export PATH=$HOME/.local/owed-bin:/opt/homebrew/opt/node@24/bin:$PATH   # node 24, pnpm 11.11.0
cd plugin && pnpm install --frozen-lockfile && pnpm unit && pnpm test   # test = typecheck + deterministic double build + conformance
cd web && pnpm install --frozen-lockfile && pnpm build
```
zsh on this machine wraps `node`, `curl` and `rm` in functions that block: use `command node`, Node `fetch` or `python3 -I` for HTTP, and new directories instead of deleting.

## Rules
- Money: decimal strings at the edges, `bigint` atomic units inside. Never floats.
- Requester-written text (`for`, `note`, names) is untrusted: strip URLs/control chars, cap length, render quoted, never as a verified identity.
- Plugin runtime: fresh sandbox per call, 10 s budget, HTTPS only to configured exact hosts, no secrets in code (brokered headers only), no network at startup or tool discovery, no timestamps/randomness at module load (the build must be byte-identical twice).
- One lockfile writer per package: dependencies are added by the LEAD session on `main`, pinned exact.
- Commit small, as work lands, on your own branch. Never rewrite history. Never push to `main` (LEAD merges).
- Never commit strategy, judging notes, submission text, video scripts or handoffs. The pre-commit guard blocks the obvious ones.
