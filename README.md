# Owed

Owed is a PayBox plugin that lets your agent ask anyone for money, then tells you who has paid.

**Live:** [www.getowed.xyz](https://www.getowed.xyz) · [/proof](https://www.getowed.xyz/proof) · [/llms.txt](https://www.getowed.xyz/llms.txt) · Solana mainnet, real funds, USDC or SOL.

Owed never holds money and charges no fees. Every payment goes from the payer's wallet straight to the recipient in one Solana transaction that the payer approves with a passkey in PayBox. The plugin returns unsigned proposals and never signs anything.

## What's live

Six tools, uploaded to the PayBox developer portal (build of `main`, hosted checks passed, 6 tools; see [docs/FACTS.md](docs/FACTS.md)).

| Tool | What it does |
|---|---|
| `ask_for_money` | Creates a request and returns a short link, a QR code and a ready-to-send message. Anyone can pay it by scanning the QR with a Solana wallet app or from their own PayBox agent. |
| `check_payments` | Checks up to 20 requests on Solana mainnet: open, paid, underpaid, not found, with payer, amount and transaction once paid. |
| `pay_link` | Pays an Owed link or any Solana Pay transfer link with one unsigned transaction for the user to approve in PayBox. It refuses checkout links (transaction requests), paid requests and amounts above `max_amount`. |
| `verify_payee` | Checks whether a domain publishes the wallet a request pays, reading DNS from the plugin itself. |
| `split_bill` | Splits a bill into one request per person and a live board that shows who has paid. |
| `create_invoice` | Creates a printable invoice with line items, due date and invoice number, payable by QR, link or the client's agent. |

Pages: a pay page per request (`/r/<id>`) with QR, wallet button, live status and receipt; a board per split (`/g/<id>`); a printable invoice (`/i/<id>`); a stateless page for raw Solana Pay links (`/p`); and [/proof](https://www.getowed.xyz/proof), which lists payments made to or from the team's own wallets with their transactions.

## Why your agent can trust what it pays

- **The link fingerprints the payment.** A request id is a hash of the recipient, token, amount and reference. Before proposing a payment, `pay_link` recomputes it from what the server returns and refuses on a mismatch, so Owed's server can't change who gets paid or how much behind a link someone already shared. This covers the Solana Pay rail.
- **Verified payee.** A requester proves a domain by publishing a TXT record `_owed.<domain>` → `owed-pay=<wallet>`. When a request names a domain, `pay_link` reads that record itself over DNS-over-HTTPS (cloudflare-dns.com, then dns.google), not through Owed's server, and refuses a wallet the domain doesn't list. Verified means the domain lists the wallet. It says who controls the domain, not that the request is fair. Lookalike spellings, internationalized names, brand words and names placed in front of another domain come with a caution.
- **Requester text is quoted, never trusted.** Names and notes are stripped of links and invisible characters, capped, shown in quotes as "written by the requester", and flagged when they mention a brand.

Example record (live): `_owed.getowed.xyz` TXT `owed-pay=FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs`.

## Use it in PayBox

Owed is in the PayBox developer portal and not yet listed in the public PayBox marketplace. Once it is:

1. Connect PayBox to your agent (Claude or any MCP client) and turn on the Owed plugin in PayBox.
2. Ask: "Ask Priya for 15 USDC for dinner". Your agent returns a link to send.
3. Ask: "Did Priya pay?" Or, to pay someone else's link: "Pay this: https://www.getowed.xyz/r/…", then approve with your passkey.

Run the plugin from source:

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH   # Node 24, pnpm 11.11.0
cd plugin && pnpm install --frozen-lockfile && pnpm test   # typecheck, deterministic double build, conformance
```

`plugin/dist/plugin.mjs` is the file uploaded to the portal. It needs HTTPS access to `www.getowed.xyz`, `owed-omega.vercel.app`, `solana-rpc.publicnode.com`, `api.mainnet-beta.solana.com`, `cloudflare-dns.com` and `dns.google`, and reads one non-secret variable, `OWED_BASE_URL` (default `https://owed-omega.vercel.app`; the portal sets `https://www.getowed.xyz`).

## Layout

- `plugin/`: the PayBox plugin (TypeScript MCP server over stdio, bundled to `dist/plugin.mjs`), built from the PayBox plugin starter v1.0.2.
- `web/`: the pages and the JSON API at `/api/v1` (Next.js on Vercel, Neon Postgres).
- `contract/`: canonical API examples that both `plugin/src/contract.ts` and `web/lib/contract.ts` must parse.
- `e2e/`: an MCP harness that runs the bundle the way PayBox does (fresh process per call, 10 s, exact-host network rules) and decodes every proposed transaction.

More: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how it fits together and what each part guarantees), [docs/FACTS.md](docs/FACTS.md) (every number and claim, with how it was verified), [docs/TESTING.md](docs/TESTING.md) (every test layer and the exact commands).

## Built with AI assistance

Code in this repository is written with Claude Code. Design decisions, testing on mainnet and accountability are the author's.
