import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import bs58 from "bs58";
import { discoverWallets, toHex, type BrowserWallet } from "@/app/alerts/browser-wallet";
import { alertChannels, emailConfig, telegramConfig } from "@/lib/alerts/config";
import { EmailError, normalizeEmail, sendEmail } from "@/lib/alerts/email";
import { ALERTS_MESSAGE_MAX_AGE_MS, alertsMessage, alertsPrefix } from "@/lib/alerts/grammar";
import { alertFacts, confirmEmail, emailAlert, escapeHtml, headline, railLabel, telegramAlert, type AlertFacts } from "@/lib/alerts/messages";
import { deepLink, parseCommand, secretMatches, sendTelegram, TelegramError } from "@/lib/alerts/telegram";
import { AlertTokenBody, CreateAlertBody } from "@/lib/contract";
import type { RequestRow } from "@/lib/requests";
import { checkSignedMessage, SIGNATURE_MAX_AGE_MS } from "@/lib/verify-signature";

// S1 paid alerts, the parts without a database: the signed message, the bot's command parsing and secret check,
// configuration, what an alert says (and that requester text can't become markup), the Bot API and Resend clients'
// error handling (stubbed fetch: nothing is sent), and browser-wallet discovery against fake wallets.

const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

function wallet(label: string) {
  const seed = createHash("sha256").update(`owed alerts unit: ${label}`, "utf8").digest();
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const address = bs58.encode(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(12));
  return { address, sign: (m: string) => sign(null, Buffer.from(m, "utf8"), key).toString("hex"), raw: (m: Uint8Array) => Uint8Array.from(sign(null, Buffer.from(m), key)) };
}
const A = wallet("a");
const B = wallet("b");

// ---------------------------------------------------------------- the signed message

test("message grammar: 'Owed alerts for <wallet> at <ISO>' in whole UTC seconds, and the window matches the verifier's", () => {
  assert.equal(alertsPrefix(A.address), `Owed alerts for ${A.address}`);
  assert.equal(alertsMessage(A.address, Date.UTC(2026, 9, 18, 12, 0, 5, 987)), `Owed alerts for ${A.address} at 2026-10-18T12:00:05Z`);
  assert.equal(ALERTS_MESSAGE_MAX_AGE_MS, SIGNATURE_MAX_AGE_MS);
});

test("verification: good passes; stale, future, wrong wallet, other wording and tampered text fail with a reason", () => {
  const now = Date.UTC(2026, 9, 18, 12, 0, 0);
  const check = (message: string, signature: string, signer = A.address) => () => checkSignedMessage({ message, signature, signer, prefix: alertsPrefix(signer), now });
  const good = alertsMessage(A.address, now - 30_000);
  assert.equal(check(good, A.sign(good))().signer, A.address);
  assert.equal(check(good, bs58.encode(Buffer.from(A.sign(good), "hex")))().signer, A.address, "base58 (a browser wallet) works too");
  assert.equal(check(good, Buffer.from(A.sign(good), "hex").toString("base64"))().signer, A.address, "and base64");
  const stale = alertsMessage(A.address, now - 5 * 60_000 - 1000);
  assert.throws(check(stale, A.sign(stale)), /more than 5 minutes old/);
  const future = alertsMessage(A.address, now + 61_000);
  assert.throws(check(future, A.sign(future)), /dated in the future/);
  assert.throws(check(good, B.sign(good)), /doesn't match this message for wallet/);
  const forB = alertsMessage(B.address, now);
  assert.throws(check(forB, B.sign(forB)), /must read "Owed alerts for/);
  assert.throws(check(`Owed inbox access for ${A.address} at 2026-10-18T12:00:00Z`, A.sign("x")), /must read "Owed alerts for/);
  const tampered = alertsMessage(A.address, now - 31_000);
  assert.throws(check(tampered, A.sign(good)), /doesn't match/);
  assert.throws(check(good, "zz"), /64-byte signature/);
});

// ---------------------------------------------------------------- the bot

test("parseCommand: /start <code>, /start@ThisBot, /stop in private chats only; everything else is null", () => {
  const msg = (text: unknown, type = "private", id: unknown = 42) => ({ update_id: 1, message: { chat: { id, type }, text } });
  assert.deepEqual(parseCommand(msg("/start abc_DEF-123"), "OwedAlertsBot"), { command: "start", chatId: "42", code: "abc_DEF-123" });
  assert.deepEqual(parseCommand(msg("  /start@owedalertsbot   abc  "), "OwedAlertsBot"), { command: "start", chatId: "42", code: "abc" });
  assert.deepEqual(parseCommand(msg("/start"), "OwedAlertsBot"), { command: "start", chatId: "42", code: null });
  assert.deepEqual(parseCommand(msg("/STOP"), "OwedAlertsBot"), { command: "stop", chatId: "42" });
  assert.deepEqual(parseCommand(msg("/stop@OwedAlertsBot", "private", -1001234567890), "OwedAlertsBot"), { command: "stop", chatId: "-1001234567890" });
  for (const u of [
    msg("/start@OtherBot abc"), msg("/stop", "group"), msg("/stop", "supergroup"), msg("/stop", "channel"),
    msg("hello"), msg("/help"), msg("/start a b"), msg("/stopnow"), msg(7), msg("/stop", "private", 1.5), msg("/stop", "private", "abc"),
    { update_id: 2, edited_message: msg("/stop").message }, { update_id: 3, channel_post: msg("/stop").message }, null, "x", {},
  ]) {
    assert.equal(parseCommand(u, "OwedAlertsBot"), null, JSON.stringify(u));
  }
});

test("secretMatches: only the exact secret; deepLink is t.me/<bot>?start=<code>", () => {
  assert.equal(secretMatches("s3cret-_X", "s3cret-_X"), true);
  for (const bad of [null, "", "s3cret-_x", "s3cret-_X ", "s3cret-_", "Bearer s3cret-_X"]) assert.equal(secretMatches(bad, "s3cret-_X"), false, String(bad));
  assert.equal(secretMatches("x", null), false);
  assert.equal(deepLink("OwedAlertsBot", "abc-_1"), "https://t.me/OwedAlertsBot?start=abc-_1");
});

// ---------------------------------------------------------------- configuration

test("config: a channel is on only with every variable set and well formed", () => {
  for (const n of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "TELEGRAM_WEBHOOK_SECRET", "RESEND_API_KEY", "OWED_ALERTS_FROM"]) delete process.env[n];
  assert.deepEqual(alertChannels(), { telegram: false, email: false });
  process.env.TELEGRAM_BOT_TOKEN = "123456789:AAH_test-token_0123456789abcdefghijkl";
  process.env.TELEGRAM_BOT_USERNAME = "@OwedAlertsBot";
  assert.equal(telegramConfig(), null);
  process.env.TELEGRAM_WEBHOOK_SECRET = "abc_DEF-123";
  assert.deepEqual(telegramConfig(), { token: "123456789:AAH_test-token_0123456789abcdefghijkl", username: "OwedAlertsBot", secret: "abc_DEF-123" });
  for (const [name, bad] of [["TELEGRAM_BOT_TOKEN", "not a token"], ["TELEGRAM_BOT_USERNAME", "has space"], ["TELEGRAM_WEBHOOK_SECRET", "x".repeat(257)], ["TELEGRAM_WEBHOOK_SECRET", "no/slash"]] as const) {
    const keep = process.env[name];
    process.env[name] = bad;
    assert.equal(telegramConfig(), null, `${name}=${bad}`);
    process.env[name] = keep;
  }
  process.env.RESEND_API_KEY = "re_123";
  assert.equal(emailConfig(), null, "no sender yet");
  process.env.OWED_ALERTS_FROM = "Owed alerts <alerts@getowed.xyz>";
  assert.deepEqual(emailConfig(), { apiKey: "re_123", from: "Owed alerts <alerts@getowed.xyz>" });
  process.env.OWED_ALERTS_FROM = "alerts@getowed.xyz";
  assert.ok(emailConfig());
  process.env.OWED_ALERTS_FROM = "Owed <not an address>";
  assert.equal(emailConfig(), null);
});

test("normalizeEmail and the contract bodies", () => {
  assert.equal(normalizeEmail("  Pat.Lee+owed@Example.CO.uk "), "pat.lee+owed@example.co.uk");
  for (const bad of ["", "pat", "pat@", "@x.com", "pat@x", "pat@@x.com", "pa t@x.com", "pat@x..com", ".pat@x.com", "pat.@x.com", "pät@x.com", `${"a".repeat(65)}@x.com`, 5]) {
    assert.equal(normalizeEmail(bad), null, String(bad));
  }
  const signed = { wallet: A.address, signed_message: alertsMessage(A.address, Date.now()), signature: "ab".repeat(64) };
  assert.equal(CreateAlertBody.safeParse({ ...signed, channel: "telegram" }).success, true);
  assert.equal(CreateAlertBody.safeParse({ ...signed, channel: "email", email: "pat@example.com" }).success, true);
  assert.equal(CreateAlertBody.safeParse({ ...signed, channel: "telegram", email: "pat@example.com" }).success, false, "strict per channel");
  assert.equal(CreateAlertBody.safeParse({ ...signed, channel: "email" }).success, false, "email needs an address");
  assert.equal(CreateAlertBody.safeParse({ ...signed, channel: "sms" }).success, false);
  assert.equal(CreateAlertBody.safeParse({ ...signed, wallet: "0x3806c85df527e5336f05277ab8cc3932b9abe42a", channel: "telegram" }).success, false);
  assert.equal(AlertTokenBody.safeParse({ token: "A".repeat(43) }).success, true);
  assert.equal(AlertTokenBody.safeParse({ token: "A".repeat(42) }).success, false);
  assert.equal(AlertTokenBody.safeParse({ token: "A".repeat(43), extra: 1 }).success, false);
});

// ---------------------------------------------------------------- what an alert says

const facts = (over: Partial<AlertFacts> = {}): AlertFacts => ({
  wallet: A.address, requestId: "JArQ6g9JvoWr", token: "USDC", asked: "12.5", arrived: "12.5", partial: false, forText: "dinner",
  brandWords: [], payer: B.address, rail: "Solana Pay", requestUrl: "https://www.getowed.xyz/r/JArQ6g9JvoWr",
  txUrl: "https://solscan.io/tx/abc", txName: "Solscan", ...over,
});

test("headline: paid, overpaid, part paid; rails read as words", () => {
  assert.equal(headline(facts()), "Paid: 12.5 USDC");
  assert.equal(headline(facts({ arrived: "13" })), "Paid: 13 USDC (asked 12.5)");
  assert.equal(headline(facts({ partial: true, arrived: "5" })), "Part paid: 5 of 12.5 USDC");
  assert.equal(railLabel(null), "Solana Pay");
  assert.equal(railLabel("moonpay_card"), "card, via MoonPay");
  assert.equal(railLabel("matched"), "matched by you (no reference on the payment)");
  assert.equal(railLabel("bank_<b>transfer</b>"), "bank b transfer b");
});

test("telegramAlert escapes every dynamic piece; only Owed's own tags remain; no requester text in an email subject", () => {
  const hostile = facts({ forText: `<a href="https://x">pay</a> & </code><b>`, brandWords: ['Pay"Box<'], payer: null, txUrl: null, rail: "<i>x</i>" });
  const text = telegramAlert(hostile);
  for (const tag of text.match(/<[^>]*>/g) ?? []) assert.match(tag, /^<(\/?(b|code|a)|a href="[^"<>]*")>$/, tag);
  assert.ok(text.includes("&lt;a href=&quot;https://x&quot;&gt;pay&lt;/a&gt; &amp; &lt;/code&gt;&lt;b&gt;"));
  assert.ok(text.includes("From an unknown wallet · &lt;i&gt;x&lt;/i&gt;"));
  assert.ok(!text.includes("Solscan"), "no transaction, no link");
  assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;'");

  const mail = emailAlert(hostile, "https://www.getowed.xyz/alerts/unsubscribe?token=T", "https://www.getowed.xyz/api/v1/alerts/unsubscribe?token=T");
  assert.equal(mail.subject, `Paid: 12.5 USDC to ${A.address.slice(0, 4)}…${A.address.slice(-4)}`);
  assert.ok(!mail.html.includes('<a href="https://x">'));
  assert.ok(mail.html.includes("&lt;a href=&quot;https://x&quot;&gt;"));
  assert.deepEqual(mail.headers, { "List-Unsubscribe": "<https://www.getowed.xyz/api/v1/alerts/unsubscribe?token=T>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  assert.ok(mail.text.endsWith("Turn them off: https://www.getowed.xyz/alerts/unsubscribe?token=T"));
  const confirm = confirmEmail(A.address, "https://www.getowed.xyz/alerts/confirm?token=T");
  assert.match(confirm.subject, /^Confirm Owed paid alerts for /);
  assert.ok(confirm.text.includes("nothing is sent unless the link is confirmed"));
});

test("alertFacts cleans the stored reason again (old rows, raw links) and reads the payment from the row", () => {
  const row = {
    id: "JArQ6g9JvoWr", recipient: A.address, token: "SOL", amountAtomic: 3_027_000n, paidAmountAtomic: 1_000_000n, status: "underpaid",
    forText: "rent www.evil.example‮gnp.exe  now", flags: ["brand_word:irs"], paidPayer: B.address, paidRail: "x402",
    paidSignature: "5".repeat(88), fromDomain: null, fromDomainVerifiedAt: null,
  } as unknown as RequestRow;
  const f = alertFacts(row, A.address, "https://owed.example/");
  assert.equal(f.partial, true);
  assert.equal(headline(f), "Part paid: 0.001 of 0.003027 SOL");
  assert.equal(f.forText, "rent now", "the link and the bidi trick around it are gone");
  assert.deepEqual(f.brandWords.length, 1);
  assert.equal(f.rail, "x402");
  assert.equal(f.requestUrl, "https://owed.example/r/JArQ6g9JvoWr");
  assert.equal(f.txUrl, `https://solscan.io/tx/${"5".repeat(88)}`);
});

// ---------------------------------------------------------------- the clients (stubbed fetch: nothing leaves the machine)

const TG = { token: "123456789:AAH_secret_token_value_0123456789", username: "OwedAlertsBot", secret: "s" };

test("sendTelegram: HTML, no previews, chat id as given; errors are classified and never carry the token", async () => {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  let answer: () => Response | Promise<Response> = () => Response.json({ ok: true, result: {} });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return answer();
  }) as typeof fetch;
  await sendTelegram(TG, "-1001234567890", "<b>hi</b>");
  assert.equal(seen[0].url, `https://api.telegram.org/bot${TG.token}/sendMessage`);
  assert.deepEqual(seen[0].body, { chat_id: "-1001234567890", text: "<b>hi</b>", parse_mode: "HTML", link_preview_options: { is_disabled: true } });

  const cases: Array<[() => Response | Promise<Response>, Partial<TelegramError>, RegExp]> = [
    [() => Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 }), { permanent: true, endsSubscription: true }, /HTTP 403: Forbidden: bot was blocked/],
    [() => Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 }), { permanent: true, endsSubscription: true }, /chat not found/],
    [() => Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, { status: 400 }), { permanent: true, endsSubscription: false }, /can't parse entities/],
    [() => Response.json({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } }, { status: 429 }), { permanent: false, retryAfterSeconds: 7 }, /HTTP 429/],
    [() => new Response("<html>oops</html>", { status: 502 }), { permanent: false }, /^Telegram Bot API answered HTTP 502$/],
    [() => Response.json({ ok: false }, { status: 200 }), { permanent: false }, /HTTP 200/],
    [() => { throw new TypeError(`fetch failed for https://api.telegram.org/bot${TG.token}/sendMessage`); }, { permanent: false }, /^Telegram Bot API unreachable$/],
    [() => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }, { permanent: false }, /^Telegram Bot API timed out$/],
  ];
  for (const [respond, want, message] of cases) {
    answer = respond;
    const err = await sendTelegram(TG, "42", "x").then(() => null, (e: unknown) => e);
    assert.ok(err instanceof TelegramError, String(err));
    assert.match(err.message, message);
    assert.ok(!err.message.includes(TG.token) && !err.message.includes("AAH_secret"), err.message);
    for (const [k, v] of Object.entries(want)) assert.equal((err as unknown as Record<string, unknown>)[k], v, `${message} ${k}`);
  }
  await assert.rejects(sendTelegram(TG, "not-a-chat", "x"), (e: unknown) => e instanceof TelegramError && e.permanent);
});

test("sendEmail: Resend's API with Idempotency-Key; 4xx refusals are permanent, 429/5xx/network are not; the key never leaks", async () => {
  const cfg = { apiKey: "re_live_secret_value", from: "Owed alerts <alerts@getowed.xyz>" };
  const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  let answer: () => Response = () => Response.json({ id: "x" });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) });
    return answer();
  }) as typeof fetch;
  await sendEmail(cfg, { to: "pat@example.com", subject: "S", text: "T", html: "<p>H</p>", headers: { "List-Unsubscribe": "<https://x/u>" }, idempotencyKey: "owed-alert-1-abc" });
  assert.equal(seen[0].url, "https://api.resend.com/emails");
  assert.equal(seen[0].headers.authorization, "Bearer re_live_secret_value");
  assert.equal(seen[0].headers["idempotency-key"], "owed-alert-1-abc");
  assert.deepEqual(seen[0].body, { from: cfg.from, to: ["pat@example.com"], subject: "S", text: "T", html: "<p>H</p>", headers: { "List-Unsubscribe": "<https://x/u>" } });
  for (const [status, permanent] of [[422, true], [403, true], [401, true], [429, false], [409, false], [500, false], [503, false]] as const) {
    answer = () => Response.json({ statusCode: status, message: `nope re_live_secret_value`.replace("re_live_secret_value", "x"), name: "e" }, { status });
    const err = await sendEmail(cfg, { to: "a@b.co", subject: "s", text: "t", html: "h" }).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof EmailError);
    assert.equal(err.permanent, permanent, String(status));
    assert.ok(!err.message.includes(cfg.apiKey));
  }
});

// ---------------------------------------------------------------- browser wallets (fake ones: no extension needed)

function fakeWindow() {
  const target = new EventTarget() as EventTarget & { solana?: unknown };
  (globalThis as unknown as { window: unknown }).window = target;
  return target;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("discoverWallets: Wallet Standard wallets (registered before or after the page), injected fallback, listed once", async () => {
  const win = fakeWindow();
  const signer = wallet("browser");
  const standard = (name: string) => ({
    name,
    accounts: [],
    features: {
      "standard:connect": { connect: async () => ({ accounts: [{ address: signer.address }] }) },
      "solana:signMessage": { signMessage: async ({ message }: { message: Uint8Array }) => [{ signedMessage: message, signature: signer.raw(message) }] },
    },
  });
  // A wallet that loaded first listens for the app's ready event; one that loads later dispatches register-wallet.
  win.addEventListener("wallet-standard:app-ready", (e) => (e as CustomEvent<{ register: (w: unknown) => void }>).detail.register(standard("Early")));
  win.solana = { connect: async () => ({ publicKey: { toBase58: () => signer.address, toString: () => signer.address } }), signMessage: async () => ({ signature: new Uint8Array(64) }) };
  let seen: BrowserWallet[] = [];
  const stop = discoverWallets((w) => (seen = w));
  await flush();
  assert.deepEqual(seen.map((w) => w.name), ["Early"], "the injected provider of a standard wallet isn't listed twice");
  win.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: { register: (w: unknown) => void }) => api.register(standard("Late")) }));
  await flush();
  assert.deepEqual(seen.map((w) => w.name), ["Early", "Late"]);
  // Signing: the exact bytes, verified as the server would.
  const message = alertsMessage(signer.address, Date.now());
  const [early] = seen;
  assert.deepEqual(await early.connect(), [signer.address]);
  const sig = await early.signMessage(signer.address, new TextEncoder().encode(message));
  assert.equal(checkSignedMessage({ message, signature: toHex(sig), signer: signer.address, prefix: alertsPrefix(signer.address) }).signer, signer.address);
  await assert.rejects(early.signMessage(A.address, new TextEncoder().encode(message)), /didn't share that address/);
  stop();
});

test("discoverWallets: a wallet that signs different bytes is refused; with no standard wallet the injected one is used", async () => {
  const win = fakeWindow();
  const signer = wallet("legacy");
  win.addEventListener("wallet-standard:app-ready", (e) => (e as CustomEvent<{ register: (w: unknown) => void }>).detail.register({
    name: "Prefixer",
    features: {
      "standard:connect": { connect: async () => ({ accounts: [{ address: signer.address }] }) },
      "solana:signMessage": { signMessage: async ({ message }: { message: Uint8Array }) => [{ signedMessage: new Uint8Array([1, ...message]), signature: new Uint8Array(64) }] },
    },
  }));
  let seen: BrowserWallet[] = [];
  let stop = discoverWallets((w) => (seen = w));
  await flush();
  await seen[0].connect();
  await assert.rejects(seen[0].signMessage(signer.address, new Uint8Array([1, 2])), /signed a different text/);
  stop();

  const plain = fakeWindow();
  plain.solana = {
    connect: async () => ({ publicKey: { toString: () => signer.address } }),
    signMessage: async (m: Uint8Array, display: string) => {
      assert.equal(display, "utf8");
      return { signature: signer.raw(m) };
    },
  };
  stop = discoverWallets((w) => (seen = w));
  await flush();
  assert.deepEqual(seen.map((w) => [w.key, w.name]), [["injected", "Browser wallet"]]);
  assert.deepEqual(await seen[0].connect(), [signer.address]);
  const message = alertsMessage(signer.address, Date.now());
  const sig = await seen[0].signMessage(signer.address, new TextEncoder().encode(message));
  assert.equal(checkSignedMessage({ message, signature: toHex(sig), signer: signer.address, prefix: alertsPrefix(signer.address) }).signer, signer.address);
  stop();
  delete (globalThis as unknown as { window?: unknown }).window;
});
