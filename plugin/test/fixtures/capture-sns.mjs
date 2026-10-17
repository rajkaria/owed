// Captures real Solana mainnet RPC exchanges for SNS name resolution into test/fixtures/sns/*.json (W3-S).
//
//   cd plugin && node --import tsx test/fixtures/capture-sns.mjs            # every case
//   cd plugin && node --import tsx test/fixtures/capture-sns.mjs <file>...  # selected cases
//   OWED_CAPTURE_RPC=<url> node --import tsx test/fixtures/capture-sns.mjs  # another RPC (default api.mainnet-beta)
//
// It runs src/sns.ts itself with a recording RPC, so each fixture stores the calls exactly as the resolver
// sends them ({method, params, result}); test/sns.test.ts (plugin) and web/test/sns.test.ts replay them and
// fail on any call that wasn't recorded. Results are stored verbatim; nothing is edited by hand.
//
// `sdk` is what SNS's own SDK returns for the name: from its mainnet test vectors
// (github.com/SolanaNameService/sns-sdk, js/tests/sns/resolve.test.ts, resolve with the default
// allowPda: false), or the rule it applies, for the other names. The tests require Owed to agree with it,
// except where Owed is stricter on purpose (an off-curve wallet is never paid).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSnsName } from "../../src/sns.ts";

const RPC = process.env.OWED_CAPTURE_RPC ?? "https://api.mainnet-beta.solana.com";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "sns");

const CASES = {
  // SNS's own test names (sns-ip-5-wallet-N.sns): one per rule of SNS-IP 5.
  "ip5-tokenized": { input: "sns-ip-5-wallet-1.sns", sdk: { wallet: "ALd1XSrQMCPSRayYUoUZnp6KcP6gERfJhWzkP49CkXKs" }, owed: "tokenized", note: "Active NFT record: the SDK returns the NFT's holder; Owed can't read the holder over public RPC and refuses." },
  "ip5-record-v2": { input: "sns-ip-5-wallet-2.sns", sdk: { wallet: "AxwzQXhZNJb9zLyiHUQA12L2GL7CxvUNrp6neee6r3cA" }, note: "Valid SOL record v2 (staleness = owner, RoA = content)." },
  "ip5-unverified-roa": { input: "sns-ip-5-wallet-3.sns", sdk: { error: "WrongValidation" }, note: "SOL record v2 with RoA validation UnverifiedSolana." },
  "ip5-stale-record": { input: "sns-ip-5-wallet-4.sns", sdk: { wallet: "7PLHHJawDoa4PGJUK3mUnusV7SEVwZwEyV5csVzm86J4" }, note: "SOL record v2 set by a previous owner: ignored, the owner is used." },
  "ip5-pda-stale": { input: "sns-ip-5-wallet-5.sns", sdk: { error: "PdaOwnerNotAllowed" }, note: "Stale record and a program-address owner." },
  "ip5-pda-record": { input: "sns-ip-5-wallet-6.sns", sdk: { error: "PdaOwnerNotAllowed" }, note: "Program-address owner; record stale." },
  "ip5-record-v1": { input: "sns-ip-5-wallet-7.sns", sdk: { wallet: "53Ujp7go6CETvC7LTyxBuyopp5ivjKt6VSfixLm1pQrH" }, note: "SOL record v1 signed by the owner." },
  "ip5-bad-v1": { input: "sns-ip-5-wallet-8.sns", sdk: { wallet: "ALd1XSrQMCPSRayYUoUZnp6KcP6gERfJhWzkP49CkXKs" }, note: "SOL record v1 whose signature doesn't verify: the owner is used." },
  "ip5-owner": { input: "sns-ip-5-wallet-9.sns", sdk: { wallet: "ALd1XSrQMCPSRayYUoUZnp6KcP6gERfJhWzkP49CkXKs" }, note: "No records: the owner." },
  "ip5-pda-owner": { input: "sns-ip-5-wallet-11.sns", sdk: { error: "PdaOwnerNotAllowed" }, note: "No records, program-address owner." },
  "ip5-unverified-roa-2": { input: "sns-ip-5-wallet-12.sns", sdk: { error: "WrongValidation" }, note: "SOL record v2 with RoA validation UnverifiedSolana, current owner." },
  // SNS's wallet-guide names, including subdomains.
  "guide-record-v2": { input: "wallet-guide-6.sns", sdk: { wallet: "Hf4daCT4tC2Vy9RCe9q8avT68yAsNJ1dQe6xiQqyGuqZ" }, note: "SOL record v2." },
  "guide-subdomain-0": { input: "sub-0.wallet-guide-3.sns", sdk: { wallet: "Fxuoy3gFjfJALhwkRcuKjRdechcgffUApeYAfMWck6w8" }, note: "Subdomain, owner." },
  "guide-subdomain-1": { input: "sub-1.wallet-guide-3.sns", sdk: { wallet: "Hf4daCT4tC2Vy9RCe9q8avT68yAsNJ1dQe6xiQqyGuqZ" }, note: "Subdomain owned by another wallet than its parent." },
  // Other real names.
  "bonfida": { input: "bonfida.sns", sdk: { wallet: "Fw1ETanDZafof7xEULsnq9UY6o71Tpds89tNwPkWLb1v" }, note: "Bonfida's name: an inactive NFT record (tag 3), no SOL record: the owner." },
  "record-off-curve": { input: "gamaedtech.sns", sdk: { wallet: "8oAaAbMmbYzaFcg1cAwzhaXd5KtbpFay5wWUXx6AmoRv" }, owed: "no_wallet", note: "Valid SOL record v2 naming an off-curve address: the SDK returns it, Owed refuses (not a wallet)." },
  "record-pda-owner": { input: "dappit.sns", sdk: { wallet: "RgaHiHXjVqDZ8vqNkK5aXHDLtT9eZXzUFqy4Ktoo1CH" }, note: "Program-address owner with a valid SOL record v2: the record's wallet." },
  "cjk-tokenized": { input: "加布.sns", sdk: { rule: "active NFT record: the NFT's holder" }, owed: "tokenized", note: "Han-only name (accepted by the name rules), tokenized: refused." },
  "unregistered": { input: "owed-sns-fixture-unregistered-7f3a.sns", sdk: { error: "DomainDoesNotExist" }, note: "No such name." },
};

let id = 0;
async function rpcCall(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const body = await res.json();
  if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
  return body.result;
}

mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
for (const [file, c] of Object.entries(CASES)) {
  if (only.length && !only.includes(file)) continue;
  const calls = [];
  const result = await resolveSnsName(c.input, async (method, params) => {
    const result = await rpcCall(method, params);
    calls.push({ method, params, result });
    return result;
  });
  // Results carry the slot they were read at; the resolver ignores context, so it is stored as read.
  const fixture = { input: c.input, note: c.note, sdk: c.sdk, ...(c.owed && { owed: c.owed }), captured_from: new URL(RPC).host, result, calls };
  writeFileSync(join(OUT, `${file}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(file, result.ok ? `${result.wallet} (${result.source})` : result.code);
  await new Promise((r) => setTimeout(r, 800));
}
