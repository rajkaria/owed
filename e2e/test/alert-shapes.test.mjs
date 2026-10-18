// S1 paid alerts: contract/shapes.mjs holds the alert API to its rules: the signed message reads "Owed alerts for
// <wallet> at <ISO>" for the body's own wallet and (hex, as PayBox returns it) verifies; a telegram reply's link is
// exactly t.me/<bot>?start=<code> and lasts 15 minutes, an email reply's confirm link 24 hours; tokens are 43 base64url
// characters; each channel takes only its own fields.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { check, shapes } from "../../contract/shapes.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));
const errors = (shape, value) => check(shapes[shape], value).errors.join("\n");

test("the recorded alert fixtures pass with no warnings", () => {
  for (const [name, shape] of [
    ["alerts.create.telegram.req.json", "createAlertReq"], ["alerts.create.telegram.res.json", "createAlertRes"],
    ["alerts.create.email.req.json", "createAlertReq"], ["alerts.create.email.res.json", "createAlertRes"],
    ["alerts.confirm.req.json", "alertTokenReq"], ["alerts.confirm.res.json", "confirmAlertRes"],
    ["alerts.unsubscribe.req.json", "alertTokenReq"], ["alerts.unsubscribe.res.json", "unsubscribeAlertRes"],
  ]) assert.deepEqual(check(shapes[shape], fixture(name)), { errors: [], warnings: [] }, name);
});

test("sign-up bodies: the wallet's own message, a signature that verifies, one channel's fields", () => {
  const tg = fixture("alerts.create.telegram.req.json");
  const mail = fixture("alerts.create.email.req.json");
  assert.match(errors("createAlertReq", { ...tg, wallet: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }), /must read "Owed alerts for/);
  assert.match(errors("createAlertReq", { ...tg, signed_message: tg.signed_message.replace(/:(\d\d)Z$/, (_m, s) => `:${String((Number(s) + 1) % 60).padStart(2, "0")}Z`) }), /does not verify/);
  assert.match(errors("createAlertReq", { ...tg, signed_message: tg.signed_message.replace("Owed alerts", "Owed ledger access") }), /must read/);
  assert.match(errors("createAlertReq", { ...tg, channel: "sms" }), /not one of telegram\|email/);
  const { email, ...noEmail } = mail;
  assert.ok(email);
  assert.match(errors("createAlertReq", noEmail), /email: missing/);
  assert.match(errors("createAlertReq", { ...mail, email: "not an address" }), /an email address/);
  assert.ok(check(shapes.createAlertReq, { ...tg, email: "x@example.com" }).warnings.some((w) => /email: not in the contract/.test(w)));
});

test("sign-up replies: the deep link is exactly the bot and code, and each link lasts its channel's time", () => {
  const tg = fixture("alerts.create.telegram.res.json");
  const mail = fixture("alerts.create.email.res.json");
  assert.match(errors("createAlertRes", { ...tg, telegram: { ...tg.telegram, link: "https://t.me/SomeoneElseBot?start=" + tg.telegram.code } }), /not https:\/\/t\.me\/<bot>\?start=<code>/);
  assert.match(errors("createAlertRes", { ...tg, expires_at: mail.expires_at }), /not 15 minutes after created_at/);
  assert.match(errors("createAlertRes", { ...mail, expires_at: tg.expires_at }), /not 24 hours after created_at/);
  assert.match(errors("createAlertRes", { ...tg, status: "active" }), /status/);
  assert.match(errors("createAlertRes", { ...tg, telegram: { ...tg.telegram, code: "has space in it!!" } }), /a \/start code/);
});

test("tokens and the confirm/unsubscribe replies", () => {
  assert.match(errors("alertTokenReq", { token: "short" }), /43-char base64url token/);
  assert.match(errors("alertTokenReq", { token: "A".repeat(42) + "=" }), /43-char base64url token/);
  assert.match(errors("confirmAlertRes", { ...fixture("alerts.confirm.res.json"), channel: "telegram" }), /channel/);
  assert.match(errors("unsubscribeAlertRes", { ...fixture("alerts.unsubscribe.res.json"), already_unsubscribed: "no" }), /already_unsubscribed/);
});
