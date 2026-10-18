# Owed

Owed is a PayBox plugin that lets your agent ask anyone for money, then tells you who has paid.

**Live:** [www.getowed.xyz](https://www.getowed.xyz) · [/proof](https://www.getowed.xyz/proof) · [/llms.txt](https://www.getowed.xyz/llms.txt) · Solana mainnet (USDC or SOL) and Base (USDC), real funds. Ask in your own currency and Owed locks the USDC at a live rate.

Owed never holds money and charges no fees. Every payment goes from the payer's wallet straight to the recipient in one transaction. From PayBox, the payer approves it with a passkey; the plugin returns unsigned proposals and never signs anything.

## What's new

Everything below is on production from `main` cecfbd2 (2026-10-17 21:56 UTC). The full list, with dates, is in [docs/CHANGELOG.md](docs/CHANGELOG.md).

- **Find payments that lost their link** (`match_payments`). Exchanges and some wallets drop the Solana Pay reference, so the money arrives and the request stays open. Owed lists transfers of exactly the amount still owed, with reasons and ambiguity warnings, and counts one only after the recipient signs that it is theirs. For an underpaid request it asks for exactly the rest.
- **Ask in your own currency.** `ask_for_money`, `split_bill` and `create_invoice` take `currency` (38 ISO 4217 codes): "ask Priya for ₹1,200" locks 12.636934 USDC at a live rate, rounded up, and every page shows both amounts.
- **Get paid to an `.sns` name.** Owed resolves Solana Name Service names on Solana itself, shows "To bonfida.sns · verified on-chain", and `pay_link` refuses if the name has moved to another wallet since. `.sol` is refused: SNS moved to `.sns` in August 2026.
- **USDC on Base.** `chain: "base"` makes an EIP-681 link any Base wallet opens; Owed reads Base for its status. First Base payment: request `XL1u7xuWoAmw`.
- **Phantom scans count.** The QR is a Solana Pay transaction request (`/api/v1/pay/<id>`): the wallet signs a transaction Owed built, with the reference inside. First wallet QR payment: request `qNaosx73zzt3`.
- **Pay by card with MoonPay: built, not switched on.** A payer without a wallet buys exactly the USDC owed in MoonPay's checkout, delivered straight to the recipient; Owed marks it paid only when Solana confirms the transfer MoonPay names. Merged with migration 0014 applied; it stays off until MoonPay live keys are set (`NEXT_PUBLIC_OWED_MOONPAY=1` plus keys).
- **[/proof](https://www.getowed.xyz/proof) shows what Owed refuses**, each case with where it was seen: production, mainnet, the PayBox test console or a unit test.

## What's live

Eleven tools, submitted to PayBox Chapter 1: the build of `main` cecfbd2 passed the developer portal's hosted checks with 11 tools (see [docs/FACTS.md](docs/FACTS.md)).

| Tool | What it does |
|---|---|
| `ask_for_money` | Creates a request and returns a short link, a QR code and a ready-to-send message. Anyone can pay it by scanning the QR with a Solana wallet app or from their own PayBox agent. Ask in USDC, SOL or your own `currency`; to a wallet or an `.sns` name; with `chain: "base"`, in USDC on Base. |
| `check_payments` | Checks up to 20 requests on Solana mainnet (and Base, for Base requests): open, paid, underpaid, cancelled, expired, not found, with payer, amount and transaction once paid. A payment matched by the recipient says so. |
| `pay_link` | Pays an Owed link, any Solana Pay transfer link or an `.sns` name with one unsigned transaction for the user to approve in PayBox. It refuses checkout links (transaction requests), paid requests, amounts above `max_amount` and names that no longer point to the request's wallet. With `rail: "x402"`, it pays an Owed USDC request over x402 instead: PayBox pays the request's x402 endpoint and the facilitator covers the network fee. |
| `verify_payee` | Checks whether a domain publishes the wallet a request pays, reading DNS from the plugin itself, or which wallet an `.sns` name points to on Solana. |
| `split_bill` | Splits a bill into one request per person and a live board that shows who has paid. In your own currency, every share is locked to USDC at one rate. |
| `create_invoice` | Creates a printable invoice with line items, due date and invoice number, payable by QR, link or the client's agent. Lines can be priced in your own currency; the total is locked to USDC. |
| `who_owes_me` | Lists your open and recently paid requests with totals, after you sign one message with your PayBox wallet (no money moves). Anyone can create a request that pays your wallet, so it marks requester text unverified. |
| `write_reminder` | Drafts a polite, firm or formal reminder with the link and days outstanding; it reads the status first and drafts nothing for a paid request. |
| `ask_every_month` | Asks someone for the same amount every month: stores a monthly schedule and opens a new Owed request on that day (UTC); each month's request works with every other tool. |
| `cancel_request` | Cancels one of your own requests, shares or invoices after you sign one message with the wallet it pays: its page shows Cancelled and `pay_link` refuses it. A paid request can't be cancelled. |
| `match_payments` | Finds money that reached your wallet but was never counted: exchanges and some wallets drop the Solana Pay reference. It lists transfers of exactly the amount still owed, with reasons and ambiguity warnings, and marks nothing until you sign that one is yours; the request then shows "matched by the recipient (no reference on the payment)". For an underpaid request it asks for exactly the rest. |

Pages: a pay page per request (`/r/<id>`) with QR, wallet button, live status and receipt; a board per split (`/g/<id>`); a printable invoice (`/i/<id>`); a Solana Pay transaction request per request (`/api/v1/pay/<id>`, what the QR encodes); an x402 endpoint per request (`/x/<id>`) that any x402 agent can pay; a stateless page for raw Solana Pay links (`/p`); and [/proof](https://www.getowed.xyz/proof), which lists payments made from the team's own wallets on every rail, with their transactions, and what Owed refuses.

## Why your agent can trust what it pays

- **The link fingerprints the payment.** A request id is a hash of the recipient, token, amount and reference. Before proposing a payment, `pay_link` recomputes it from what the server returns and refuses on a mismatch, so Owed's server can't change who gets paid or how much behind a link someone already shared. This covers the Solana Pay rail.
- **Verified payee.** A requester proves a domain by publishing a TXT record `_owed.<domain>` → `owed-pay=<wallet>`. When a request names a domain, `pay_link` reads that record itself over DNS-over-HTTPS (cloudflare-dns.com, then dns.google), not through Owed's server, and refuses a wallet the domain doesn't list. Verified means the domain lists the wallet. It says who controls the domain, not that the request is fair. Lookalike spellings, internationalized names, brand words and names placed in front of another domain come with a caution.
- **The x402 rail.** With `rail: "x402"`, your agent checks the id and the request's live x402 challenge against the request before it proposes the payment. PayBox fetches the challenge again when it pays, so "the server can't change who gets paid" stays a Solana Pay guarantee. First mainnet settle: request `FeJG9SuofqWU` through PayBox `pay_x402` (see [docs/FACTS.md](docs/FACTS.md)).
- **Names are checked on chain, every time.** An `.sns` name is resolved by the plugin itself from Solana (the name's SOL record, else its owner). The server re-resolves it when a request is made, the pay page on every render, and `pay_link` before every payment, so a request made for a name is paid only while the name still points to its wallet. Tokenized names and names with lookalike characters are refused.
- **Owed never guesses who paid.** A transfer without the request's reference is never counted on its own. `match_payments` only proposes candidates; the recipient signs which one is theirs, and the server re-checks the transaction on chain (confirmed, exactly the amount due, after the request, not counted anywhere else) before marking it "matched by the recipient (no reference on the payment)".
- **Requester text is quoted, never trusted.** Names and notes are stripped of links and invisible characters, capped, shown in quotes as "written by the requester", and flagged when they mention a brand.

Example record (live): `_owed.getowed.xyz` TXT `owed-pay=FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs`.

## Use it in PayBox

Owed is submitted to PayBox Chapter 1 and waiting for its listing in the PayBox plugin catalog (on 2026-10-17 at 22:15 UTC, PayBox's `discover_plugins` didn't return it yet). Once it is listed:

1. Connect PayBox to your agent (Claude or any MCP client) and turn on the Owed plugin in PayBox.
2. Ask: "Ask Priya for 15 USDC for dinner". Your agent returns a link to send.
3. Ask: "Did Priya pay?" Or, to pay someone else's link: "Pay this: https://www.getowed.xyz/r/…", then approve with your passkey.
4. More to try: "Ask Priya for ₹1,200 for dinner", "Pay bonfida.sns 2 USDC", "Sam says he paid from Coinbase but it still shows open", "Who still owes me?"

Run the plugin from source:

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH   # Node 24, pnpm 11.11.0
cd plugin && pnpm install --frozen-lockfile && pnpm test   # typecheck, deterministic double build, conformance
```

`plugin/dist/plugin.mjs` is the file uploaded to the portal. It needs HTTPS access to `www.getowed.xyz`, `owed-omega.vercel.app`, `solana-rpc.publicnode.com`, `api.mainnet-beta.solana.com`, `cloudflare-dns.com` and `dns.google`, and reads one non-secret variable, `OWED_BASE_URL` (default `https://owed-omega.vercel.app`; the portal sets `https://www.getowed.xyz`).

## Use it from any MCP client, or add it to PayBox by URL

Owed is also a remote MCP server: `https://www.getowed.xyz/api/mcp` (Streamable HTTP, no sign-in). It serves every
Owed tool, and each call runs the same plugin bundle PayBox runs (`web/mcp/owed-plugin.mjs`, a byte copy of
`plugin/dist/plugin.mjs` that CI checks), in a fresh process with PayBox's limits: 10 seconds, 256 KiB of output,
nothing from the server's environment. A new tool is live there the moment it merges, before any portal upload.

- **PayBox:** add `https://www.getowed.xyz/api/mcp` as a remote plugin (no auth). [Not yet verified: whether PayBox
  opens the passkey sheet for a `pay_link` proposal that comes from a remote plugin. Until FACTS records it, pay through
  the listed Owed plugin or any Solana wallet.]
- **Claude Code:** `claude mcp add --transport http owed https://www.getowed.xyz/api/mcp`
- **Any other client:** add the URL as a Streamable HTTP server. The endpoint speaks MCP 2026-07-28 (per-request
  `_meta`, `server/discover`) and, for clients that open with `initialize`, 2025-11-25, 2025-06-18 and 2025-03-26. It is
  stateless: JSON replies, no SSE stream, no session id. Tool calls are limited to 120 a minute per client IP.

Outside PayBox, the tools that only read or create requests (`ask_for_money`, `check_payments`, `split_bill`,
`create_invoice`, `write_reminder`, `verify_payee`, `ask_every_month`) work as they do in PayBox. `pay_link` returns
PayBox's `io.paybox/transactionProposal` (an unsigned Solana transaction); a client other than PayBox has to sign and
send it some other way. `who_owes_me`, `cancel_request` and `match_payments` need a message signed by the wallet, which
PayBox does with `request_wallet_sign`.

## Layout

- `plugin/`: the PayBox plugin (TypeScript MCP server over stdio, bundled to `dist/plugin.mjs`), built from the PayBox plugin starter v1.0.2.
- `web/`: the pages and the JSON API at `/api/v1` (Next.js on Vercel, Neon Postgres).
- `contract/`: canonical API examples that both `plugin/src/contract.ts` and `web/lib/contract.ts` must parse.
- `e2e/`: an MCP harness that runs the bundle the way PayBox does (fresh process per call, 10 s, exact-host network rules) and decodes every proposed transaction.

More: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how it fits together and what each part guarantees), [docs/FACTS.md](docs/FACTS.md) (every number and claim, with how it was verified), [docs/TESTING.md](docs/TESTING.md) (every test layer and the exact commands).

## Built with AI assistance

Code in this repository is written with Claude Code. Design decisions, testing on mainnet and accountability are the author's.
