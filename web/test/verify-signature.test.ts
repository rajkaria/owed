import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  SIGNATURE_MAX_AGE_MS, SIGNATURE_MAX_SKEW_MS, checkSignedMessage, isSmallOrder, isoSeconds, ledgerPrefix,
  parseIsoUtc, signatureCandidates, verifyMessageSignature,
} from "@/lib/verify-signature";

// A throwaway signer derived from a fixed seed: it holds nothing and exists only in this file.
// PayBox signs exactly like this (ed25519 over the UTF-8 bytes, @moon-x/solana-adapter 0.3.0) and returns hex.
const seed = createHash("sha256").update("owed test signer: verify-signature.test.ts").digest();
const KEY = nacl.sign.keyPair.fromSeed(Uint8Array.from(seed));
const SIGNER = bs58.encode(KEY.publicKey);
const OTHER = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";

const NOW = Date.UTC(2026, 9, 17, 10, 30, 0);
const message = (at = NOW, who = SIGNER) => `${ledgerPrefix(who)} at ${isoSeconds(at)}`;
const sign = (text: string) => nacl.sign.detached(new TextEncoder().encode(text), KEY.secretKey);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const check = (over: Partial<Parameters<typeof checkSignedMessage>[0]> = {}) => {
  const msg = over.message ?? message();
  return checkSignedMessage({ message: msg, signature: hex(sign(msg)), signer: SIGNER, prefix: ledgerPrefix(SIGNER), now: NOW, ...over });
};
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string; message: string });
  }
  assert.fail("expected a refusal");
};

test("the ledger message is the exact SPEC wording with a whole-second UTC time", () => {
  assert.equal(message(), `Owed ledger access for ${SIGNER} at 2026-10-17T10:30:00Z`);
  assert.equal(isoSeconds(NOW + 999), "2026-10-17T10:30:00Z");
});

test("a signature verifies as hex (PayBox), 0x-hex, base58 and base64", () => {
  const msg = message();
  const sig = sign(msg);
  for (const text of [hex(sig), `0x${hex(sig)}`, hex(sig).toUpperCase(), bs58.encode(sig), Buffer.from(sig).toString("base64"),
    Buffer.from(sig).toString("base64url")]) {
    assert.equal(verifyMessageSignature(msg, text, SIGNER), true, text);
  }
  const v = check();
  assert.equal(v.signer, SIGNER);
  assert.equal(v.signedAtMs, NOW);
  assert.equal(v.messageHash, createHash("sha256").update(message()).digest("hex"));
});

test("a changed message, another wallet or a changed byte is refused", () => {
  const msg = message();
  const sig = sign(msg);
  assert.equal(verifyMessageSignature(`${msg} `, hex(sig), SIGNER), false);
  assert.equal(verifyMessageSignature(msg, hex(sig), OTHER), false);
  const flipped = Uint8Array.from(sig);
  flipped[10] ^= 1;
  assert.equal(verifyMessageSignature(msg, hex(flipped), SIGNER), false);
  assert.match(refusal(() => check({ signature: hex(flipped) })).message, /doesn't match this message for wallet/);
});

test("a malleated signature (S + L) verifies in tweetnacl but is refused here", () => {
  const msg = message();
  const sig = sign(msg);
  const L = (1n << 252n) + 27742317777372353535851937790883648493n;
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i]);
  const s2 = s + L;
  assert.ok(s2 < 1n << 256n);
  const forged = Uint8Array.from(sig);
  let rest = s2;
  for (let i = 32; i < 64; i++) {
    forged[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  assert.equal(nacl.sign.detached.verify(new TextEncoder().encode(msg), forged, KEY.publicKey), true);
  assert.equal(verifyMessageSignature(msg, hex(forged), SIGNER), false);
});

test("small-order keys never verify: a forgery that tweetnacl accepts is refused", () => {
  // For a small-order key A and a small-order R, S = 0 satisfies [S]B = R + [h]A whenever [h]A = -R.
  // Searching messages finds such a forgery for each listed point, which proves the list is right.
  const points = [
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0100000000000000000000000000000000000000000000000000000000000000",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
  ].map((h) => Uint8Array.from(Buffer.from(h, "hex")));
  for (const key of points) {
    assert.equal(isSmallOrder(key), true);
    let forged: { text: string; sig: Uint8Array } | null = null;
    for (let i = 0; i < 400 && !forged; i++) {
      const text = `${ledgerPrefix(bs58.encode(key))} at ${isoSeconds(NOW - i * 1000)}`;
      for (const r of points) {
        const sig = new Uint8Array(64);
        sig.set(r, 0);
        if (nacl.sign.detached.verify(new TextEncoder().encode(text), sig, key)) {
          forged = { text, sig };
          break;
        }
      }
    }
    assert.ok(forged, `no forgery found for ${Buffer.from(key).toString("hex")}`);
    assert.equal(verifyMessageSignature(forged.text, hex(forged.sig), bs58.encode(key)), false);
  }
  assert.equal(isSmallOrder(KEY.publicKey), false);
  assert.equal(isSmallOrder(bs58.decode(OTHER)), false);
});

test("fresh means at most 5 minutes old and at most 1 minute ahead", () => {
  assert.equal(check({ message: message(NOW - SIGNATURE_MAX_AGE_MS) }).signedAtMs, NOW - SIGNATURE_MAX_AGE_MS);
  assert.match(refusal(() => check({ message: message(NOW - SIGNATURE_MAX_AGE_MS - 1000) })).message, /more than 5 minutes old/);
  assert.equal(check({ message: message(NOW + SIGNATURE_MAX_SKEW_MS) }).signedAtMs, NOW + SIGNATURE_MAX_SKEW_MS);
  assert.match(refusal(() => check({ message: message(NOW + SIGNATURE_MAX_SKEW_MS + 1000) })).message, /dated in the future/);
});

test("the wording must be exact: prefix, wallet and time", () => {
  const r = (msg: string) => refusal(() => check({ message: msg }));
  assert.equal(r(message(NOW, OTHER)).code, "invalid_input");
  assert.match(r(message(NOW, OTHER)).message, /must read "Owed ledger access for /);
  assert.match(r(`owed ledger access for ${SIGNER} at 2026-10-17T10:30:00Z`).message, /must read/);
  assert.match(r(`Owed ledger access for ${SIGNER} at 2026-10-17 10:30:00`).message, /must end with a UTC time/);
  assert.match(r(`Owed ledger access for ${SIGNER} at 2026-10-17T10:30:00+00:00`).message, /must end with a UTC time/);
  assert.match(r(`Owed ledger access for ${SIGNER} at 2026-10-17T10:30:00Z please`).message, /must end with a UTC time/);
  assert.match(r(`${"x".repeat(201)}`).message, /at most 200 characters/);
  // Milliseconds are fine: an agent may write new Date().toISOString().
  const withMs = `${ledgerPrefix(SIGNER)} at 2026-10-17T10:29:59.123Z`;
  assert.equal(check({ message: withMs }).signedAtMs, NOW - 877);
  assert.match(refusal(() => check({ signer: "not-a-wallet" })).message, /base58 Solana address/);
});

test("ISO parsing rejects impossible dates", () => {
  assert.equal(parseIsoUtc("2026-10-17T10:30:00Z"), NOW);
  assert.equal(parseIsoUtc("2026-02-31T00:00:00Z"), null);
  assert.equal(parseIsoUtc("2026-10-17T24:00:00Z"), null);
  assert.equal(parseIsoUtc("2026-10-17T10:30:60Z"), null);
  assert.equal(parseIsoUtc("2026-10-17T10:30:00.1Z"), NOW + 100);
});

test("signature text that is no 64-byte encoding is refused before any verification", () => {
  assert.deepEqual(signatureCandidates(""), []);
  assert.deepEqual(signatureCandidates("ab".repeat(63)), []);
  assert.deepEqual(signatureCandidates("z".repeat(201)), []);
  assert.match(refusal(() => check({ signature: "hello" })).message, /hex \(what PayBox returns\), base58 or base64/);
});
