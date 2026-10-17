import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyStatus, boardDescription, boardFromGroup, boardTitle, paidLine, progress, receivedLine, unsettledIds,
} from "@/app/g/[id]/model";
import type { PublicGroup } from "@/lib/groups";

const fixture = (name: string): PublicGroup =>
  JSON.parse(readFileSync(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));
const ORIGIN = "https://owed-omega.vercel.app";
const open = () => boardFromGroup(fixture("groups.create.res.json"), ORIGIN);

test("board model: links on this origin, quoted names, totals and the 0 of 3 line", () => {
  const m = open();
  assert.equal(m.link, `${ORIGIN}/g/${m.id}`);
  assert.deepEqual(m.shares.map((s) => [s.label, s.quoted, s.amount, s.status]), [
    ["Priya", true, "0.5", "open"], ["Sam", true, "0.5", "open"], ["Alex", true, "0.5", "open"],
  ]);
  assert.equal(m.shares[0]!.payLink, `${ORIGIN}/r/${m.shares[0]!.id}`);
  assert.equal(m.requester, "Raj");
  assert.equal(m.title, "Pizza night");
  const p = progress(m);
  assert.equal(paidLine(p), "0 of 3 paid");
  assert.equal(receivedLine(m, p), "0 of 1.5 USDC received");
  assert.equal(p.done, false);
  assert.deepEqual(p.segments.map((s) => s.basisPoints), [3333, 3333, 3333]);
  assert.deepEqual(unsettledIds(m), m.shares.map((s) => s.id));
});

test("board model: the 2-of-3 fixture renders as 2 of 3 paid, 1 of 1.5 USDC", () => {
  const m = boardFromGroup(fixture("groups.get.res.json"), ORIGIN);
  const p = progress(m);
  assert.equal(paidLine(p), "2 of 3 paid");
  assert.equal(receivedLine(m, p), "1 of 1.5 USDC received");
  assert.equal(m.shares[0]!.payer, "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  assert.deepEqual(unsettledIds(m), [m.shares[2]!.id]);
  assert.equal(boardTitle(m, p), "Split bill: 2 of 3 paid");
  assert.equal(
    boardDescription(m, p),
    "1 of 1.5 USDC received for “Pizza night”. Pay your share with any Solana wallet, or with your AI agent in PayBox.",
  );
});

test("applyStatus: flips paid and underpaid shares from one /status response", () => {
  const m = open();
  const [a, b, c] = m.shares.map((s) => s.id);
  const next = applyStatus(m, {
    results: [
      { id: a, status: "paid", amount_requested: "0.5", token: "USDC", amount_paid: "0.5", payer: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        signature: "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv", paid_at: "2026-10-17T07:41:12Z" },
      { id: b, status: "underpaid", amount_requested: "0.5", token: "USDC", amount_paid: "0.2", payer: "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ",
        signature: "3vQB7B6MrGQZaxCuFg4oh2Unh6Y9iVUqwWGGYZz2fMqAaQ8k1fSZcJqL6vdpWNMfBtHn6b1Z3nZbV6HkYcGLt8QF", paid_at: "2026-10-17T07:44:57Z" },
      { id: c, status: "open", amount_requested: "0.5", token: "USDC" },
    ],
  });
  assert.deepEqual(next.shares.map((s) => s.status), ["paid", "underpaid", "open"]);
  const p = progress(next);
  assert.equal(paidLine(p), "1 of 3 paid");
  assert.equal(receivedLine(next, p), "0.7 of 1.5 USDC received");
  assert.deepEqual(unsettledIds(next), [b, c]);
  assert.equal(m.shares[0]!.status, "open", "the previous model is not mutated");
});

test("applyStatus: ignores junk and never moves a paid share backwards", () => {
  const m = open();
  assert.equal(applyStatus(m, null), m);
  assert.equal(applyStatus(m, { results: "nope" }), m);
  assert.equal(applyStatus(m, { results: [{ id: "other", status: "paid" }, { status: "paid" }, 7] }), m);
  assert.equal(applyStatus(m, { results: [{ id: m.shares[0]!.id, status: "not_found" }] }), m);
  const paid = applyStatus(m, { results: [{ id: m.shares[0]!.id, status: "paid", amount_paid: "0.5" }] });
  assert.equal(paid.shares[0]!.status, "paid");
  const back = applyStatus(paid, { results: [{ id: m.shares[0]!.id, status: "open" }] });
  assert.equal(back.shares[0]!.status, "paid");
});

test("every share paid: done, and the board stops polling", () => {
  const m = open();
  const all = applyStatus(m, { results: m.shares.map((s) => ({ id: s.id, status: "paid", amount_paid: "0.5" })) });
  const p = progress(all);
  assert.equal(p.done, true);
  assert.equal(paidLine(p), "3 of 3 paid");
  assert.equal(receivedLine(all, p), "1.5 of 1.5 USDC received");
  assert.deepEqual(unsettledIds(all), []);
});

test("untrusted text: links stripped, missing names become 'Person N', brand words hide the requester and title", () => {
  const g = fixture("groups.create.res.json");
  const m = boardFromGroup({
    ...g, title: "pizza at www.evil.example", requester_name: "MoonPay Support",
    shares: g.shares.map((s, i) => ({ ...s, name: i === 1 ? "​" : s.name })),
  }, ORIGIN);
  assert.equal(m.title, "pizza at");
  assert.equal(m.requester, null);
  assert.deepEqual(m.brandWords, ["MoonPay"]);
  assert.deepEqual(m.shares.map((s) => [s.label, s.quoted]), [["Priya", true], ["Person 2", false], ["Alex", true]]);
  const p = progress(m);
  assert.equal(boardTitle(m, p), "Split bill: 0 of 3 paid");
  assert.doesNotMatch(boardDescription(m, p), /pizza|MoonPay/i);
});

test("uneven shares size their segments by amount", () => {
  const g = fixture("groups.create.res.json");
  const m = boardFromGroup({ ...g, total: "2", shares: g.shares.map((s, i) => ({ ...s, amount: i === 0 ? "1" : "0.5" })) }, ORIGIN);
  assert.deepEqual(progress(m).segments.map((s) => s.basisPoints), [5000, 2500, 2500]);
});
