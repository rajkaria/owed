// Re-capture the Helius webhooks API fixture (W3-A). Creates one raw webhook on a fresh, never-used
// reference key, edits it, reads it, deletes it, and records each exchange, plus the errors for a
// wrong API key and an unknown id. About 400 Helius credits. Nothing is ever delivered (no transaction
// can carry a key generated here a moment ago).
//   cd web && vercel env pull .env.local --environment=development
//   command node --env-file=.env.local test/fixtures/helius/capture.mjs
// The API key travels only in the query string and is never written; authHeader and the account's
// wallet are replaced with placeholders before anything is saved.
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import bs58 from "bs58";

const API = "https://api-mainnet.helius-rpc.com/v0/webhooks";
const KEY = process.env.HELIUS_API_KEY?.trim();
if (!KEY) throw new Error("HELIUS_API_KEY is not set (vercel env pull .env.local --environment=development)");
const HOOK = "https://owed-git-w3a-notify-rajkaria67-1831s-projects.vercel.app/api/hooks/helius";
const AUTH = `capture-${randomBytes(12).toString("hex")}`;
const ref = () => bs58.encode(randomBytes(32));
const [A, B] = [ref(), ref()];

const exchanges = [];
let wallet = null;
const scrub = (text) => {
  let out = text.split(AUTH).join("<authHeader>");
  if (wallet) out = out.split(wallet).join("<wallet>");
  if (out.includes(KEY)) throw new Error("a response echoed the API key; nothing written");
  return out;
};

async function call(name, method, path, body, key = KEY) {
  const res = await fetch(`${API}${path}?api-key=${encodeURIComponent(key)}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.wallet) wallet ??= parsed.wallet;
  exchanges.push({ name, method, path, request: body === undefined ? null : JSON.parse(scrub(JSON.stringify(body))), status: res.status, body: text });
  console.log(`${name}: ${method} ${path || "/"} -> ${res.status}`);
  return { status: res.status, body: parsed };
}

const spec = (addresses) => ({ webhookURL: HOOK, webhookType: "raw", transactionTypes: ["ANY"], accountAddresses: addresses, authHeader: AUTH });
let id = null;
try {
  const created = await call("create", "POST", "", spec([A]));
  id = created.body?.webhookID ?? null;
  if (!id) throw new Error(`create failed: HTTP ${created.status}`);
  await call("update", "PUT", `/${id}`, spec([A, B]));
  await call("get", "GET", `/${id}`);
  const all = await call("list", "GET", "");
  if (Array.isArray(all.body)) {
    // Keep only the webhook made here; the account's other webhooks are none of the fixture's business.
    const last = exchanges.at(-1);
    last.body = JSON.stringify(all.body.filter((w) => w.webhookID === id));
    last.note = "filtered to the webhook created by this capture";
  }
  await call("update-unknown-id", "PUT", `/${randomUUID()}`, spec([A]));
  await call("list-wrong-key", "GET", "", undefined, randomUUID());
} finally {
  if (id) {
    await call("delete", "DELETE", `/${id}`);
    await call("update-after-delete", "PUT", `/${id}`, spec([A]));
  }
}

const out = {
  name: "helius-webhooks-api",
  note: "Helius webhooks API exchanges (api-mainnet.helius-rpc.com/v0/webhooks), captured by test/fixtures/helius/capture.mjs. authHeader and wallet replaced with placeholders; the API key never leaves the query string.",
  captured_at: new Date().toISOString(),
  hook_url: HOOK,
  addresses: [A, B],
  exchanges: exchanges.map((e) => ({ ...e, body: scrub(e.body) })),
};
writeFileSync(new URL("webhooks-api.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log("wrote webhooks-api.json");
