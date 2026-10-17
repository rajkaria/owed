# Changelog

What reached production, newest first. Times are UTC. Every line is backed by [FACTS.md](FACTS.md), which says how it was verified.

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
