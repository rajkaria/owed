# Owed

Owed is a PayBox plugin that lets your agent ask anyone for money, then tells you who has paid.

Status: under construction for MoonPay Hackathons: PayBox Chapter 1 (Oct 16–17, 2026). This README lists only what is live; it will grow as features ship on Solana mainnet.

## Layout

- `plugin/` — the PayBox marketplace plugin (TypeScript MCP server, bundled to `dist/plugin.mjs`), built from the PayBox plugin starter v1.0.2.
- `web/` — the pay page and API (Next.js on Vercel).
- `contract/` — canonical API request/response examples shared by both.

## Built with AI assistance

Code in this repository is written with Claude Code. Design decisions, testing on mainnet and accountability are the author's.
