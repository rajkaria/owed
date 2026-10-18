# Owed

Owed is a PayBox plugin that lets your agent ask anyone for money, then tells you who has paid.

**Live:** [www.getowed.xyz](https://www.getowed.xyz) · [/proof](https://www.getowed.xyz/proof) · [/llms.txt](https://www.getowed.xyz/llms.txt) · Solana mainnet (USDC or SOL) and Base (USDC), real funds. Ask in your own currency and Owed locks the USDC at a live rate.

Owed never holds money and charges no fees. Every payment goes from the payer's wallet straight to the recipient in one transaction. From PayBox, the payer approves it with a passkey; the plugin returns unsigned proposals and never signs anything.

## What's new

Pots, monthly pay, group ledgers, invoice terms and refunds, funding plans and the X-handle inbox are on the [remote MCP endpoint](#use-it-from-any-mcp-client-or-add-it-to-paybox-by-url) and go into the PayBox portal build with its next upload (their pages and API routes are on production). Paid alerts are on production since 2026-10-18; everything else since `main` cecfbd2 (2026-10-17 21:56 UTC). The full list, with dates, is in [docs/CHANGELOG.md](docs/CHANGELOG.md).

- **Chip-in pots.** `start_pot` starts a pot for a gift, a dinner or a trip kitty, paid straight to your wallet, with an optional target, a suggested amount or fixed amounts, and a deadline (30 days by default, 90 at most: every pot ends). Share the board (`/pot/<id>`): each scan of its QR code is counted on its own, anyone's agent pays it with `pay_link` and an amount, x402 agents pay a preset at `/x/pot/<id>/<amount>`, and the board shows the total against the target as money lands. Past the deadline every way to pay refuses.
- **One-tap monthly pay within your rule.** `set_autopay` stores a rule you sign for one requester's wallet ("up to 1,500 USDC a request and 1,500 a month until June"). `what_do_i_owe` then marks each request eligible, over the limit or not covered, and hands your agent the exact PayBox `pay_x402` call for the eligible ones; anything above the rule waits for you. Owed never pays anything itself, and whether PayBox pays inside its autonomous limits without a tap isn't tested yet.
- **Paid alerts in Telegram.** [/alerts](https://www.getowed.xyz/alerts) links a Telegram chat with [@getowedbot](https://t.me/getowedbot) to the wallet your requests pay, after that wallet signs one message: one message per paid request, on every rail, and `/stop` turns it off. Email alerts are built and stay off until a sending key exists.
- **Cash out and pay by bank: built, not switched on.** `cash_out` sells USDC to MoonPay for your bank with one transfer you approve, to a deposit address only MoonPay names; invoices can show "Pay by bank transfer" to the recipient's own MoonPay virtual account, counted only once Solana shows MoonPay's USDC delivery. Each sits behind its own flag until MoonPay live keys (and, for bank transfers, MoonPay Enterprise access) exist.
- **Group ledgers.** Start a tab for a trip, add expenses as they happen (even, by shares, exact, or straight off a receipt photo, in USDC or the local currency), and settle up with the fewest payments: one Owed request per payment, payable straight to the person owed and waiting in the payer's own agent inbox when the ledger has their wallet. Every expense is signed by a wallet in the ledger; Owed never holds the money.
- **Invoices with terms, and refunds.** `create_invoice` takes installments (2 to 12) or an early-payment discount, a late fee and chase days. Every term that changes the amount is a new request, so no link ever changes what it asks: later installments open 7 days before they are due, paying the early price cancels the full price (and the other way round), and the late fee opens once, only if the invoice wasn't paid on time. `who_owes_me` says when a polite, firm or formal reminder is due and makes a client's monthly statement (page and CSV). `refund_payment` sends all or part of a payment back to the wallet that paid it, never more than was paid, and it counts once Solana confirms it.
- **A short balance never ends a payment.** If your wallet can't cover a request, `pay_link` and `pay_all` hand your agent the exact PayBox calls that fix it: swap SOL for USDC (sized at Pyth's price), bring USDC over from Base, swap another token, buy exactly the shortfall with MoonPay (at least its 4.99 USD minimum), or pay over x402 when only the network fee is missing. You approve each step in PayBox, and the final payment is re-checked from scratch.
- **Ask by X handle; pay several requests with one approval.** Ask `@sam` and Sam's agent finds it in `what_do_i_owe` without a pasted link; `pay_all` pays several requests in one Solana transaction, every request checked like `pay_link`. Handles are labels Owed never verifies; the payer's agent checks them with PayBox `resolve_username` before paying.
- **Find payments that lost their link** (`match_payments`). Exchanges and some wallets drop the Solana Pay reference, so the money arrives and the request stays open. Owed lists transfers of exactly the amount still owed, with reasons and ambiguity warnings, and counts one only after the recipient signs that it is theirs. For an underpaid request it asks for exactly the rest.
- **Ask in your own currency.** `ask_for_money`, `split_bill` and `create_invoice` take `currency` (38 ISO 4217 codes): "ask Priya for ₹1,200" locks 12.636934 USDC at a live rate, rounded up, and every page shows both amounts.
- **Get paid to an `.sns` name.** Owed resolves Solana Name Service names on Solana itself, shows "To bonfida.sns · verified on-chain", and `pay_link` refuses if the name has moved to another wallet since. `.sol` is refused: SNS moved to `.sns` in August 2026.
- **USDC on Base.** `chain: "base"` makes an EIP-681 link any Base wallet opens; Owed reads Base for its status. First Base payment: request `XL1u7xuWoAmw`.
- **Phantom scans count.** The QR is a Solana Pay transaction request (`/api/v1/pay/<id>`): the wallet signs a transaction Owed built, with the reference inside. First wallet QR payment: request `qNaosx73zzt3`.
- **Pay by card with MoonPay: built, not switched on.** A payer without a wallet buys exactly the USDC owed in MoonPay's checkout, delivered straight to the recipient; Owed marks it paid only when Solana confirms the transfer MoonPay names. Merged with migration 0014 applied; it stays off until MoonPay live keys are set (`NEXT_PUBLIC_OWED_MOONPAY=1` plus keys).
- **[/proof](https://www.getowed.xyz/proof) shows what Owed refuses**, each case with where it was seen: production, mainnet, the PayBox test console or a unit test.

## What's live

Twenty-one tools. Eleven are in the build submitted to PayBox Chapter 1: `main` cecfbd2 passed the developer portal's hosted checks with 11 tools (see [docs/FACTS.md](docs/FACTS.md)). `what_do_i_owe`, `pay_all`, `start_ledger`, `add_expense`, `ledger_balances`, `settle_up`, `refund_payment`, `start_pot`, `set_autopay` and `cash_out` are on the [remote MCP endpoint](#use-it-from-any-mcp-client-or-add-it-to-paybox-by-url) and go into the portal build with its next upload. So do the newer parts of the first eleven marked below: funding plans and pots in `pay_link`, invoice terms in `create_invoice`, reminders and statements in `who_owes_me`, overpayments in `match_payments` and refunds in `check_payments`.

| Tool | What it does |
|---|---|
| `ask_for_money` | Creates a request and returns a short link, a QR code and a ready-to-send message. Anyone can pay it by scanning the QR with a Solana wallet app or from their own PayBox agent. Ask in USDC, SOL or your own `currency`; to a wallet or an `.sns` name; with `chain: "base"`, in USDC on Base. With `payer` (an X handle resolved by PayBox, an `.sns` name or a wallet) it lands in that person's `what_do_i_owe` inbox. |
| `check_payments` | Checks up to 20 requests on Solana mainnet (and Base, for Base requests): open, paid, underpaid, cancelled, expired, not found, with payer, amount and transaction once paid. A payment matched by the recipient says so. A payment sent back with `refund_payment` says "refunded <amount>" once Solana confirms it (remote MCP endpoint now). |
| `pay_link` | Pays an Owed link, any Solana Pay transfer link or an `.sns` name with one unsigned transaction for the user to approve in PayBox. It refuses checkout links (transaction requests), paid requests, amounts above `max_amount` and names that no longer point to the request's wallet. With `rail: "x402"`, it pays an Owed USDC request over x402 instead: PayBox pays the request's x402 endpoint and the facilitator covers the network fee. If the wallet is short, it proposes nothing and returns a funding plan instead: the PayBox calls that fix it (swap, bridge from Base, MoonPay buy link, or x402 for a fee-only shortfall), each ending with `pay_link` again (remote MCP endpoint now). |
| `verify_payee` | Checks whether a domain publishes the wallet a request pays, reading DNS from the plugin itself, or which wallet an `.sns` name points to on Solana. |
| `split_bill` | Splits a bill into one request per person and a live board that shows who has paid. In your own currency, every share is locked to USDC at one rate. With a `payer` per person, each share lands in that person's `what_do_i_owe` inbox. |
| `create_invoice` | Creates a printable invoice with line items, due date and invoice number, payable by QR, link or the client's agent. Lines can be priced in your own currency; the total is locked to USDC. With the client as `payer`, it lands in their `what_do_i_owe` inbox. Terms (remote MCP endpoint now): installments (2 to 12, monthly or every N days) or an early-payment discount until a date, a late fee and chase days; each amount-changing term is its own request, and the invoice shows Paid only when every installment is. |
| `who_owes_me` | Lists your open and recently paid requests with totals, after you sign one message with your PayBox wallet (no money moves). Anyone can create a request that pays your wallet, so it marks requester text unverified. On the remote MCP endpoint it also says when a polite, firm or formal reminder is due on an overdue invoice and, for one client and month, returns a statement (invoices, payments, refunds, balance) with a CSV and a page link. |
| `write_reminder` | Drafts a polite, firm or formal reminder with the link and days outstanding; it reads the status first and drafts nothing for a paid request. |
| `ask_every_month` | Asks someone for the same amount every month: stores a monthly schedule and opens a new Owed request on that day (UTC); each month's request works with every other tool. With `payer`, every month's request lands in that person's `what_do_i_owe` inbox. |
| `cancel_request` | Cancels one of your own requests, shares or invoices after you sign one message with the wallet it pays: its page shows Cancelled and `pay_link` refuses it. A paid request can't be cancelled. |
| `match_payments` | Finds money that reached your wallet but was never counted: exchanges and some wallets drop the Solana Pay reference. It lists transfers of exactly the amount still owed, with reasons and ambiguity warnings, and marks nothing until you sign that one is yours; the request then shows "matched by the recipient (no reference on the payment)". For an underpaid request it asks for exactly the rest. On the remote MCP endpoint it also lists requests paid more than they asked, each with the `refund_payment` call for the difference. |
| `what_do_i_owe` | Lists the open requests, split-bill shares and invoices someone addressed to your wallet (by your X handle, `.sns` name or wallet), after you sign one message with your PayBox wallet (no money moves): who asked (their words, unverified), what for, how long it has waited, due dates and totals, with Base requests listed apart. Marks first-time requesters; `block` hides every request from one requester wallet. Remote MCP endpoint now; portal build from the next upload. |
| `pay_all` | Pays several requests with one approval: up to 20 ids, in one Solana transaction, each request checked like `pay_link` (id, open, sanctions, DNS, `.sns`), capped by `max_total`. Requests with a brand-word caution are skipped unless the user names them, and Base requests are left to `pay_link`. A transaction holds 1,232 bytes (about 6 to 9 payments), so it pays the first ones and names the rest. Short of the total, it returns a funding plan for exactly the requests that passed the checks. Remote MCP endpoint now; portal build from the next upload. |
| `start_ledger` | Starts a group ledger (trip, flat, team) with you as owner and up to 19 others, each optionally identified by X handle (resolved by PayBox), `.sns` name or wallet. Nothing is owed until expenses are added. Remote MCP endpoint now; portal build from the next upload. |
| `add_expense` | Records who paid what and how it splits: even, shares, exact, or a receipt's items with tax and tip spread pro rata. Local currencies are locked to USDC per expense. Signed by a wallet in the ledger. Remote MCP endpoint now; portal build from the next upload. |
| `ledger_balances` | Who is owed, who owes (USDC, local currency beside), the settle-up plan and each settle-up request's live status, all re-checked by the plugin. Remote MCP endpoint now; portal build from the next upload. |
| `settle_up` | Turns the balances into at most n − 1 Owed requests, each paid straight to the person owed and addressed to the person who owes it. Remote MCP endpoint now; portal build from the next upload. |
| `start_pot` | Starts a chip-in pot paid straight to your wallet: optional target, a suggested amount, fixed amounts or any amount, up to 4 USDC presets for x402 agents, and a deadline (30 days by default, 90 at most). Returns the board link, its QR codes and the x402 preset links. The pot's id is a hash of the wallet, the token and a nonce, so a payer's agent checks the pot pays you before paying. Remote MCP endpoint now; portal build from the next upload. |
| `set_autopay` | One-tap monthly pay within your rule: sign (or revoke) a rule for one requester's wallet with a maximum per request and per month and an end date. `what_do_i_owe` then gives your agent the exact PayBox `pay_x402` call for requests within it, checked against your signed rule and the request's live x402 challenge. Owed never pays anything itself. Remote MCP endpoint now; portal build from the next upload. |
| `cash_out` | Cashes out USDC to your bank through MoonPay: the first call returns MoonPay's sell link for the exact amount; once MoonPay waits for the deposit, the second proposes one USDC transfer from your wallet to the address MoonPay named for that sale, approved with your passkey. No input takes an address. Built and switched off until MoonPay live keys are set. Remote MCP endpoint now; portal build from the next upload. |
| `refund_payment` | Refunds all or part of a payment to the wallet that paid it (USDC or SOL): two calls, a signed message and then one transfer to approve in PayBox. Refunds never add up to more than was paid; card and hand-matched payments aren't refunded here. Remote MCP endpoint now; portal build from the next upload. |

Pages: a pay page per request (`/r/<id>`) with QR, wallet button, live status and receipt; a board per split (`/g/<id>`); a printable invoice (`/i/<id>`, with its installments, both prices, late fee and refunds when it has terms) and a client's monthly statement (`/i/statement`, a 10-minute signed link); a group ledger (`/l/<id>`: balances, settle-up requests polled live, and each expense with its signed message); a chip-in pot's board (`/pot/<id>`: the total against the target, every contribution, printable QR codes); paid alerts (`/alerts`); a Solana Pay transaction request per request (`/api/v1/pay/<id>`, what the QR encodes); an x402 endpoint per request (`/x/<id>`) and per pot preset (`/x/pot/<id>/<amount>`) that any x402 agent can pay; a stateless page for raw Solana Pay links (`/p`); and [/proof](https://www.getowed.xyz/proof), which lists payments made from the team's own wallets on every rail, with their transactions, and what Owed refuses.

## Why your agent can trust what it pays

- **The link fingerprints the payment.** A request id is a hash of the recipient, token, amount and reference. Before proposing a payment, `pay_link` recomputes it from what the server returns and refuses on a mismatch, so Owed's server can't change who gets paid or how much behind a link someone already shared. This covers the Solana Pay rail.
- **Verified payee.** A requester proves a domain by publishing a TXT record `_owed.<domain>` → `owed-pay=<wallet>`. When a request names a domain, `pay_link` reads that record itself over DNS-over-HTTPS (cloudflare-dns.com, then dns.google), not through Owed's server, and refuses a wallet the domain doesn't list. Verified means the domain lists the wallet. It says who controls the domain, not that the request is fair. Lookalike spellings, internationalized names, brand words and names placed in front of another domain come with a caution.
- **The x402 rail.** With `rail: "x402"`, your agent checks the id and the request's live x402 challenge against the request before it proposes the payment. PayBox fetches the challenge again when it pays, so "the server can't change who gets paid" stays a Solana Pay guarantee. First mainnet settle: request `FeJG9SuofqWU` through PayBox `pay_x402` (see [docs/FACTS.md](docs/FACTS.md)).
- **Names are checked on chain, every time.** An `.sns` name is resolved by the plugin itself from Solana (the name's SOL record, else its owner). The server re-resolves it when a request is made, the pay page on every render, and `pay_link` before every payment, so a request made for a name is paid only while the name still points to its wallet. Tokenized names and names with lookalike characters are refused.
- **Owed never guesses who paid.** A transfer without the request's reference is never counted on its own. `match_payments` only proposes candidates; the recipient signs which one is theirs, and the server re-checks the transaction on chain (confirmed, exactly the amount due, after the request, not counted anywhere else) before marking it "matched by the recipient (no reference on the payment)".
- **Handles are claims, not identities.** A request may carry the requester's X handle; the pay page shows it as "not verified by Owed", and `pay_link` / `pay_all` hand the payer's agent a check: call PayBox `resolve_username` and refuse if the handle doesn't resolve to the wallet the request pays. Anyone can address a request to anyone, so `what_do_i_owe` marks first-time requesters and says that names, handles and reasons are the requester's own words.
- **A funding plan never skips a check.** Plans come only after every refusal (paid, expired, tampered, sanctioned, a payee that doesn't check out), list exact PayBox calls the user approves one by one, and end with the same `pay_link` / `pay_all` call, which re-runs every check before it proposes anything. Owed's server learns that a plan was offered and its shortfall, never balances.
- **A ledger is checked, not trusted.** Every expense carries its recorder's wallet signature over a digest of exactly what is stored; the plugin and the contract check re-derive every split, balance and settle-up plan, and each settle-up request's id still hashes its own recipient, amount and reference.
- **No link changes its amount.** An installment, the full price after an early discount and a late fee are each a new request with its own id; paying one price cancels the other in the same database transaction. A refund goes only to the wallet that paid, counts only once Solana shows that transfer from the refunding wallet, and refunds never add up to more than was paid.
- **A pot is checked, not trusted.** A pot's id is the hash of the wallet it pays, its token and a nonce, so the plugin refuses a pot whose server copy pays anyone else. Each contribution is an ordinary Owed request whose id hashes its own terms, minted when someone pays (a QR scan, a click, a verified x402 payment), never when a page loads.
- **Your rule is yours, and it's only data.** An autopay rule matches the requester's wallet, never a handle or a name; it carries your wallet's signature, which the plugin re-checks before it hands your agent any payment. PayBox's own limits stay the hard cap.
- **A cash-out goes only where MoonPay says.** `cash_out` has no address input: the deposit address comes only from MoonPay's signed webhook for that sale, re-read from MoonPay before it is released, and the plugin checks the amount, the wallet and MoonPay's status again before it proposes the transfer.
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
nothing from the server's environment. A new tool is live there the moment it merges, before any portal upload: `what_do_i_owe`,
`pay_all`, `start_ledger`, `add_expense`, `ledger_balances`, `settle_up`, `refund_payment`, `start_pot`, `set_autopay` and `cash_out` are there now, and the PayBox
portal build gets them with its next upload.

- **PayBox:** add `https://www.getowed.xyz/api/mcp` as a remote plugin (no auth). [Not yet verified: whether PayBox
  opens the passkey sheet for a `pay_link` or `pay_all` proposal that comes from a remote plugin. Until FACTS records it, pay through
  the listed Owed plugin or any Solana wallet.]
- **Claude Code:** `claude mcp add --transport http owed https://www.getowed.xyz/api/mcp`
- **Any other client:** add the URL as a Streamable HTTP server. The endpoint speaks MCP 2026-07-28 (per-request
  `_meta`, `server/discover`) and, for clients that open with `initialize`, 2025-11-25, 2025-06-18 and 2025-03-26. It is
  stateless: JSON replies, no SSE stream, no session id. Tool calls are limited to 120 a minute per client IP.

Outside PayBox, the tools that only read or create (`ask_for_money`, `check_payments`, `split_bill`, `create_invoice`,
`write_reminder`, `verify_payee`, `ask_every_month`, `start_ledger`, `ledger_balances`, `start_pot`) work as they do in PayBox.
`pay_link`, `pay_all`, `refund_payment` and `cash_out` return PayBox's `io.paybox/transactionProposal` (an unsigned Solana
transaction); a client other than PayBox has to sign and send it some other way. A funding plan names PayBox tools
(`request_swap`, `get_buy_link`, `get_portfolio`), so outside PayBox it is a list of steps to do with your own wallet.
`who_owes_me`, `what_do_i_owe`, `cancel_request`, `match_payments`, `add_expense`, `settle_up`, `refund_payment` and `set_autopay` need a
message signed by the wallet, which PayBox does with `request_wallet_sign`.

## Layout

- `plugin/`: the PayBox plugin (TypeScript MCP server over stdio, bundled to `dist/plugin.mjs`), built from the PayBox plugin starter v1.0.2.
- `web/`: the pages and the JSON API at `/api/v1` (Next.js on Vercel, Neon Postgres).
- `contract/`: canonical API examples that both `plugin/src/contract.ts` and `web/lib/contract.ts` must parse.
- `e2e/`: an MCP harness that runs the bundle the way PayBox does (fresh process per call, 10 s, exact-host network rules) and decodes every proposed transaction.

More: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how it fits together and what each part guarantees), [docs/FACTS.md](docs/FACTS.md) (every number and claim, with how it was verified), [docs/TESTING.md](docs/TESTING.md) (every test layer and the exact commands).

## Built with AI assistance

Code in this repository is written with Claude Code. Design decisions, testing on mainnet and accountability are the author's.

## Licence

MIT. See [LICENSE](LICENSE).
