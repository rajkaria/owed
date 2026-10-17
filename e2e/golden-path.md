# Golden path: pre-upload commands (SPEC §7 rows 1, 5, 7, 8)

Run from the repo root on `main` after the wave-1 merge, before uploading `plugin/dist/plugin.mjs` to the portal.
Every call goes through `e2e/plugin-e2e.mjs`: a fresh process per call, clean env, MCP 2026-07-28 over stdio, 10 s
budget, HTTPS only to the hosts the portal will allow. Rows 1 and 5 touch mainnet and the production API for real.

```bash
export PATH=$HOME/.local/owed-bin:/opt/homebrew/opt/node@24/bin:$PATH
export OWED=https://owed-omega.vercel.app
export TEAM=FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs
e2e() { command node e2e/plugin-e2e.mjs plugin/dist/plugin.mjs "$@"; }   # works in zsh and bash
```

## 0. Build, gates, catalog

```bash
(cd plugin && pnpm install --frozen-lockfile && pnpm unit && pnpm test)
command node web/scripts/smoke.mjs $OWED --strict
e2e                                     # tools/list with no network at all; note the sha256 it prints
```

Pass: `pnpm test` reports `"status":"passed"`, smoke has 0 fail and 0 pending, the catalog lists `ask_for_money`,
`check_payments`, `pay_link` (and no `echo` after LEAD removes it), every tool shows annotations and an outputSchema.
The sha256 printed here is the file you upload.

## Row 1: ask for money (hosted), ≤ 3 s

```bash
LINK=$(e2e ask_for_money "{\"recipient\":\"$TEAM\",\"amount\":\"1\",\"token\":\"USDC\",\"payer_name\":\"Priya\",\"for\":\"coffee\",\"requester_name\":\"Raj\"}" \
  --expect mode=hosted --expect status=open --expect amount=1 --expect token=USDC --max-ms 3000 --print link)
echo "$LINK"
command node web/scripts/smoke.mjs $OWED --id "${LINK##*/}"     # API record, status, QR png/svg, pay page, preview image
```

Pass: exit 0, `LINK` ends in `/r/<10-char id>`, the text reads `Request ready: 1 USDC from Priya for "coffee"`,
smoke `--id` has 0 fail. Open `$LINK` on a phone for row 2.

## Row 3 preflight (no money moves): the proposal pays exactly the request

```bash
e2e pay_link "{\"link\":\"$LINK\",\"sender\":\"<ACCOUNT_B_SOLANA_ADDRESS>\"}" \
  --expect proposal.transfer.amount=1 --expect proposal.transfer.token=USDC
```

Pass: the harness decodes the unsigned transaction and matches it against `GET /api/v1/requests/<id>`: fee payer =
sender, ≤ 1,232 bytes, legacy, one `transferChecked` of 1 USDC to the recipient's USDC account, the request's
reference as a read-only key, memo `owed:<id>`. Nothing is signed. Raj then runs row 3 for real from account B.

## Row 5: did Priya pay?

```bash
e2e check_payments "{\"requests\":[\"$LINK\"]}" --expect results.0.status=open        # before row 3
e2e check_payments "{\"requests\":[\"$LINK\"]}" --expect results.0.status=paid --expect-text solscan.io   # after row 3
```

Pass (after): status `paid`, `amount_paid` 1, a `signature` and `explorer_url`; the summary reads `1 of 1 paid`.
Copy the signature into `docs/FACTS.md`.

## Row 7: Solana Pay checkout link (transaction request) is refused

```bash
e2e pay_link "{\"link\":\"solana:https%3A%2F%2Fshop.example%2Fapi%2Fsolana-pay\",\"sender\":\"$TEAM\"}" \
  --allow-error --expect-no-proposal --expect-text "Owed pays transfer links only"
```

Pass: no `io.paybox/transactionProposal` in the result, the text is the SPEC §5.1 refusal.

## Row 8: API down → offline link that still works

8a, API refuses connections (the Owed host is left out of the allowed hosts; RPC hosts stay allowed):

```bash
OFFLINE=$(e2e ask_for_money "{\"recipient\":\"$TEAM\",\"amount\":\"1\",\"token\":\"USDC\",\"for\":\"coffee\"}" \
  --hosts solana-rpc.publicnode.com,api.mainnet-beta.solana.com \
  --expect mode=offline --expect id=null --print link)
command node web/scripts/smoke.mjs $OWED --page "$OFFLINE"     # the /p?u= page renders
```

8b, API hangs (non-routable address, exercises the 4 s client timeout inside the 10 s budget):

```bash
e2e ask_for_money "{\"recipient\":\"$TEAM\",\"amount\":\"1\",\"token\":\"USDC\"}" \
  --base-url https://10.255.255.1 --hosts 10.255.255.1 --expect mode=offline --max-ms 6000
```

Pass: both return `mode: "offline"`, `id: null`, a `link` of the form `<base>/p?u=<encoded solana: URL>`; 8a's page
loads with 0 fail. In 8b the link's host is the dead base URL by construction; open the same `/p?u=…` path on `$OWED`.

## Then

Upload the file whose sha256 matched step 0. Portal hosts: `owed-omega.vercel.app`, `solana-rpc.publicnode.com`,
`api.mainnet-beta.solana.com`. Variable `OWED_BASE_URL=$OWED`. Run each tool once in the portal Test console and
Validate `pay_link` with a funded wallet (SPEC §10).
