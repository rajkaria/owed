# Changelog

What reached production, newest first. Times are UTC. Every line is backed by [FACTS.md](FACTS.md), which says how it was verified.

## 2026-10-18 14:58 · main bbefbbb · chip-in pots, one-tap monthly pay, paid alerts, MoonPay rails (off)

- **Chip-in pots** (migration 0019).
  - `start_pot` starts a pot paid straight to your wallet: optional target, suggested amount, fixed amounts or any amount, up to 4 USDC presets for x402 agents, and a deadline (30 days by default, at most 90: every pot ends).
  - The pot's id is a hash of the wallet, the token and a nonce, so a payer's agent checks the pot pays you before paying.
  - Board `/pot/<id>`: the total against the target, every contribution with its transaction, printable QR codes that are Solana Pay transaction requests (each scan makes its own contribution, so everyone is counted once), and a per-click payment link. x402 presets at `/x/pot/<id>/<amount>`.
  - `pay_link` pays a pot (board link, id or QR text) with an amount, minting one contribution right before it proposes; a short wallet gets the funding plan and mints nothing. `check_payments` shows a pot's board, `who_owes_me` lists your open pots, and nobody is ever shown as owing a pot.
  - A contribution is an ordinary Owed request, so every rail, refunds and `/proof` work on it unchanged. Past the deadline every way to pay refuses.
- **One-tap monthly pay within your rule** (migration 0022). `set_autopay` stores a rule the payer signs for one requester's wallet: a maximum per request and per month and an end date. `what_do_i_owe` marks each request eligible, over the limit or not covered, and hands the agent the exact PayBox `pay_x402` call for eligible ones, checked against the signed rule and the request's live x402 challenge. Owed never pays; whether PayBox runs it without a tap under an autonomous grant isn't tested yet.
- **PayBox Open Deposit link, built and off.** `ask_for_money` and `create_invoice` take a `deposit_url` from PayBox `get_deposit_link` (paybox.sh, USDC on Solana, never part of the id). Pay and invoice pages offer it for 24 hours only with `OWED_DEPOSIT_LINK=1`; a payment through it counts after `match_payments`.
- **Paid alerts, built** (migration 0025). `/alerts` links a Telegram chat to the wallet your requests pay after one signed message; one message per paid request on every rail, `/stop` to end it. A database trigger queues each alert in the same transaction that records the payment. It switches on when the bot's keys are set; email alerts are built and off until a sending key exists.
- **MoonPay rails, built and off** (migrations 0023, 0024).
  - `cash_out` sells USDC to MoonPay for a bank payout: MoonPay's signed sell link for the exact amount, then one USDC transfer to the deposit address only MoonPay's signed webhook names, re-checked with MoonPay before release. No input takes an address. Off until `OWED_MOONPAY_SELL=1` with live keys.
  - Pay by bank transfer on invoices, to the recipient's own MoonPay virtual account, counted only after Solana shows MoonPay's USDC delivery (rail `bank_transfer`); the Enterprise cash-out route. Both off until MoonPay Enterprise access exists.
- The remote MCP endpoint now serves 21 tools (bundle sha256 `1f24a80a…4e730`). The PayBox portal build cecfbd2 keeps 11 until the next upload.

## 2026-10-18 10:10 · main 390547d · funding plans, group ledgers, merchant-grade invoices

- **Funding plan** (migration 0018). When the payer can't cover a payment, `pay_link` and `pay_all` return the exact PayBox calls that fix it, plus a `plan_id` the server records. The options are:
  - a SOL swap sized at Pyth's on-chain price;
  - a bridge from Base;
  - a swap from another token;
  - a MoonPay buy link;
  - x402 when only the fee is short.
- **Group ledgers** (migration 0020):
  - `start_ledger`, `add_expense` (even, shares, exact amounts, or receipt items with tax and tip, plus locked local-currency quotes) and `ledger_balances`.
  - `settle_up` needs at most n−1 requests, addressed to debtors' inboxes. Writes are signed by the owner or a member.
  - The page is `/l/<id>`.
- **Merchant-grade invoices** (migration 0021):
  - `refund_payment`: signed, an unsigned transfer back to the payer, confirmed on chain.
  - Installments opened by the scheduler, or an early price paired with the full price.
  - A late fee opened once.
  - Chase days in `who_owes_me`.
  - Signed monthly statements.
- The remote MCP endpoint now serves 18 tools. The PayBox portal build cecfbd2 keeps 11 until the next upload.

## 2026-10-18 08:30 · main ab382d8 · payer inbox and pay_all, migrations on deploy

- **Ask by X handle, pay several requests with one approval** (migration 0017). Every asking tool takes `payer`: an X handle the agent resolved with PayBox `resolve_username`, an `.sns` name, or a wallet. It also takes `requester_handle`.
- `what_do_i_owe` is the payer's signed inbox, with block and unblock for a requester. `pay_all` pays several requests in one Solana transaction and runs every `pay_link` check on each one.
- Paid detection now pairs each reference with its own transfer, so one transaction can settle several requests, each exactly once.
- Live on the remote MCP endpoint (13 tools); these tools reach the PayBox plugin with its next upload.
- **Migrations ship with the deploy.** Vercel Production and Preview builds apply pending `web/db/migrations` before `next build`. Each file runs in one transaction under an advisory lock, and a failure fails the build. This build applied 0016 and 0017 to production. New build-time devDependency `pg` 8.23.1.

## 2026-10-18 07:40 · main d864a4c · remote MCP endpoint, Pay with PayBox (off)

- **Remote MCP endpoint** (`POST /api/mcp`). Any MCP client can add `https://www.getowed.xyz/api/mcp` and get every Owed tool. Each tool call runs the committed plugin bundle (`web/mcp/owed-plugin.mjs`) in a fresh process with PayBox's limits (10 s, 256 KiB, clean environment), and `tools/list` is the bundle's own. Supports MCP 2026-07-28 plus clients that open with `initialize` (2025-11-25, 2025-06-18, 2025-03-26). Stateless JSON, no sessions, 120 tool calls a minute per IP. CI fails when the copy drifts from the plugin build.
- **"New to crypto? Pay with PayBox"** on open pay pages (migration 0016), built and switched off (`OWED_PAYBOX_CTA`) until a newcomer can turn Owed on in PayBox. Owed's server counts clicks and prompt copies, with no IP, no user agent and no third-party analytics. `GET /api/v1/stats` adds `cta` totals once 0016 is applied.

## 2026-10-17 21:56 · main cecfbd2 · 11 tools, submitted

- **`match_payments`** (11th tool, migration 0012). Finds money that reached the recipient's wallet without the request's Solana Pay reference (exchanges and some wallets drop it): transfers of exactly the amount still owed, made after the request and counted nowhere else, ranked with reasons and ambiguity warnings. It marks nothing until the recipient signs a match; the server re-checks the transaction on chain and labels the request "matched by the recipient (no reference on the payment)". `ask_for_rest` makes one request for exactly what an underpaid request still owes.
- **Local-currency asks** (migration 0013). `ask_for_money`, `split_bill` and `create_invoice` take `currency`, one of 38 ISO 4217 codes. The server locks the USDC at a live rate (Coinbase's USD table, cross-checked against open.er-api.com), rounded up to 6 decimals; every surface recomputes the quote and shows both amounts. Local run: ₹1,200 → 12.636934 USDC.
- **`.sns` name payees** (migration 0015). `ask_for_money`, `pay_link` and `verify_payee` take Solana Name Service names, resolved on Solana by the plugin itself; the pay page shows "To bonfida.sns · verified on-chain" and `pay_link` refuses a name that moved. `.sol` is refused (SNS moved its names to `.sns`).
- **Pay by card with MoonPay** (migration 0014), merged with the feature off. The payer buys exactly the USDC owed in MoonPay's checkout, delivered to the recipient; the request is marked paid only when Solana confirms the transfer MoonPay names. Switches on with live keys.
- **/proof** gained "What Owed refuses" and "Paid on all three rails".
- Plugin build cecfbd2 passed the PayBox portal's hosted checks with 11 tools and was submitted to PayBox Chapter 1 (~22:00).

## 2026-10-17 18:37 · first wallet QR payment

- **Solana Pay transaction requests** (main 38ace78). The QR encodes `solana:https://www.getowed.xyz/api/v1/pay/<id>`: the wallet asks Owed for the transaction and only signs it, so the reference and memo are always inside. Phantom's scanner had turned the transfer URL into a plain send that dropped them. First payment this way: request `qNaosx73zzt3`, scanned with Phantom. Recipients on the OFAC SDN list are refused here too.

## 2026-10-17 18:12 · first x402 settle on mainnet

- Request `FeJG9SuofqWU`, 0.01 USDC through PayBox `pay_x402`, the PayAI facilitator as fee payer. The landing page's x402 copy turned on after this.

## 2026-10-17 17:37 · main 546519d · landing v3 and the new brand

- The rebuilt landing page and the Owed mark (an O with an arrow landing in it), settled-green palette.

## 2026-10-17 17:24 · first Base payment

- **USDC on Base** (W3-B). `chain: "base"` makes an EIP-681 link any Base wallet opens; Owed reads Base `Transfer` logs to mark it paid. First payment: request `XL1u7xuWoAmw`, 0.5 USDC.

## 2026-10-17 17:19 · 10-tool build

- **`cancel_request`** and `expires_in_days` (W3-C): only the wallet a request pays can cancel it, with a signature.
- **`ask_every_month`** (W3-D): a monthly schedule, opened by a daily cron; **`who_owes_me` CSV**, a 10-minute download link.
- **OFAC sanctions screen**: the plugin (no network) and every create route refuse recipients on the U.S. Treasury's SDN list.

## 2026-10-17 16:15 · main e2108b6 and 42a40d3 · 8 tools

- **`who_owes_me`** (signed ledger: every open request, split share and invoice, plus 30 days of payments) and **`write_reminder`** (friendly, firm or formal, checks the chain first).
- **Helius webhook** (W3-A): requests are marked paid as soon as the transaction is reported, even with the pay page closed. The webhook only triggers a chain re-check.

## 2026-10-17 15:25 · main f765e3e

- Landing v2, the first `/proof`, `llms.txt`.

## 2026-10-17 11:20 · main 758ba4c · wave 2, 6 tools

- **`split_bill`** with a live board, **`create_invoice`** with a printable page, the **x402 rail** (`/x/<id>`, `pay_link` `rail: "x402"`), and **verified payee** (`verify_payee`, `from_domain`: a domain's `_owed` TXT record lists the wallet, read by the plugin over DNS-over-HTTPS).

## 2026-10-17 05:57 · request ids commit to the terms

- A request id is a hash of recipient, asset, amount and reference; `pay_link` recomputes it and refuses a mismatch, so the server can't swap the payee behind a shared link.

## 2026-10-17 04:15 · first production deploy

- `ask_for_money`, `check_payments` and, by 05:40, `pay_link`, on Solana mainnet with real funds.
