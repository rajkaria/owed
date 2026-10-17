import "server-only";
import { isUniqueViolation, sql, transaction } from "./db";
import { ApiError } from "./http";
import { fromAtomic } from "./money";
import { watchSoon } from "./notify/helius"; // W3-A: a paid request leaves the Helius watch
import { COLUMNS, createRequest, fromRow, getRequest, settleFromChain, type RequestRow } from "./requests";
import { rpcBatch, type RpcOptions } from "./solana";
import { isTeamSql, teamWallets } from "./team";
import { accountKeys, creditTo, TX_PARAMS, type ParsedTransaction } from "./validate";
import { checkSignedMessage, spendOnce } from "./verify-signature";

// 0012: payments that arrived without the request's Solana Pay reference (exchanges and some wallets drop it),
// matched by the recipient. The plugin's match_payments finds candidates and explains them; nothing here guesses.
// A match is written only when the wallet the request pays signs
//   "Owed match <transaction> to <id> for <recipient> at <ISO time>"
// (PayBox request_wallet_sign, op solanaMessage; W2-D's verifier: ed25519, at most 5 minutes old, single use),
// and the chain agrees: the transaction is confirmed and successful, credits that recipient exactly what the
// request still needs (all of it when open, the remainder when underpaid), landed after the request was made,
// carries no Owed request's reference, and settles nothing else. The signed message is stored as the proof that
// the recipient attributed it; every surface labels it "matched by the recipient (no reference on the payment)".

export const MATCH_PURPOSE = "match";
/** Chain reads before matching (a fresh status check, then the transaction): under the plugin's 7 s API timeout. */
export const MATCH_CHAIN_BUDGET_MS = 4500;
/** A block time a little before the request's created_at is clock skew, not a payment made before the request. */
export const CREATED_SKEW_SECONDS = 60;

const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

export function matchPrefix(transaction: string, id: string, recipient: string): string {
  return `Owed match ${transaction} to ${id} for ${recipient}`;
}

export interface MatchInput {
  id: string;
  recipient: string;
  /** The transaction signature the recipient says paid this request. */
  transaction: string;
  signedMessage: string;
  signature: string;
  now?: number;
}

export interface MatchOutcome {
  row: RequestRow;
  /** This exact transaction was already matched to this request; nothing changed. */
  already: boolean;
}

const refuse = (message: string) => new ApiError("invalid_input", message);

/** What a request still needs: all of it while open (or expired/cancelled unpaid), the remainder when underpaid. */
export function amountDue(row: Pick<RequestRow, "status" | "amountAtomic" | "paidAmountAtomic">): { due: bigint; covers: "full" | "rest" } {
  if (row.status === "underpaid") {
    const paid = row.paidAmountAtomic ?? 0n;
    return { due: row.amountAtomic > paid ? row.amountAtomic - paid : 0n, covers: "rest" };
  }
  return { due: row.amountAtomic, covers: "full" };
}

function describePaid(row: RequestRow): string {
  if (row.match) return `it is already paid by transaction ${row.match.signature}, matched by the recipient`;
  return row.paidRail === "x402" ? "it is already paid over x402" : "it is already paid by a payment that carries its reference";
}

/** Which of these signatures already settle something, and which of these keys are an Owed request's reference. */
export async function attributedOf(signatures: readonly string[], keys: readonly string[] = []): Promise<{
  attributed: { signature: string; request_id: string; how: "reference" | "matched" | "x402" }[];
  references: { key: string; request_id: string }[];
}> {
  const [sigRows, refRows] = await Promise.all([
    signatures.length === 0 ? Promise.resolve([]) : sql(
      `select paid_signature as signature, id as request_id,
              case when paid_rail = 'matched' then 'matched' when paid_rail = 'x402' then 'x402' else 'reference' end as how
         from requests where paid_signature = any($1::text[])
       union
       select signature, request_id, 'matched' from request_matches where signature = any($1::text[])
       union
       select signature, request_id, 'x402' from x402_receipts
        where signature = any($1::text[]) and state in ('settling', 'settled', 'verified', 'unknown')
       order by 1, 2`,
      [signatures],
    ),
    keys.length === 0 ? Promise.resolve([]) : sql(`select reference as key, id as request_id from requests where reference = any($1::text[]) order by 1`, [keys]),
  ]);
  return {
    attributed: sigRows.map((r) => ({ signature: r.signature!, request_id: r.request_id!, how: r.how as "reference" | "matched" | "x402" })),
    references: refRows.map((r) => ({ key: r.key!, request_id: r.request_id! })),
  };
}

async function readTransaction(signature: string, rpc: RpcOptions): Promise<ParsedTransaction | null> {
  const [tx] = await rpcBatch([{ method: "getTransaction", params: [signature, TX_PARAMS] }], rpc);
  return (tx ?? null) as ParsedTransaction | null;
}

export async function confirmMatch(input: MatchInput, rpc: RpcOptions = { deadline: Date.now() + MATCH_CHAIN_BUDGET_MS }): Promise<MatchOutcome> {
  if (!SIGNATURE_RE.test(input.transaction)) throw refuse("transaction must be a Solana transaction signature (base58)");
  const row = await getRequest(input.id);
  if (!row) throw new ApiError("not_found", "no request with this id");
  if (row.chain === "base") throw refuse("Base requests are found by their amount already; there is nothing to match by hand");
  if (row.recipient !== input.recipient) throw refuse("only the wallet this request pays can match a payment to it, and that is not this recipient");

  // Wording, freshness and the signature by the request's own recipient; then spend it, so a replay never works.
  const verified = checkSignedMessage({
    message: input.signedMessage,
    signature: input.signature,
    signer: row.recipient,
    prefix: matchPrefix(input.transaction, row.id, row.recipient),
    now: input.now,
  });
  await spendOnce(MATCH_PURPOSE, verified);

  if (row.match?.signature === input.transaction) return { row, already: true };
  if (row.status === "paid") throw refuse(`this request can't take a match: ${describePaid(row)}`);

  // A referenced payment may have landed since the last status check: then the request is paid, no match needed.
  let checked: RequestRow;
  try {
    [checked] = await settleFromChain([row], rpc);
  } catch {
    throw new ApiError("upstream_unavailable", "Solana couldn't be read to confirm this request's state; sign a fresh message and try again shortly");
  }
  if (checked.status === "paid") throw refuse(`this request can't take a match: ${describePaid(checked)}`);
  const { due, covers } = amountDue(checked);
  if (due <= 0n) throw refuse("this request has nothing left to pay");

  let tx: ParsedTransaction | null;
  try {
    tx = await readTransaction(input.transaction, rpc);
  } catch {
    throw new ApiError("upstream_unavailable", "Solana couldn't be read to check that transaction; sign a fresh message and try again shortly");
  }
  if (!tx) throw refuse("that transaction isn't on Solana mainnet (or isn't confirmed yet)");
  if (tx.transaction.signatures[0] !== input.transaction) throw refuse("Solana answered with a different transaction");
  if (tx.meta?.err != null) throw refuse("that transaction failed on chain, so it moved no money");
  const credit = creditTo(tx, row.recipient, row.token);
  if (!credit) throw refuse(`that transaction sends no ${row.token} to ${row.recipient}`);
  if (credit.amountAtomic !== due) {
    const what = covers === "rest" ? "the remainder this underpaid request still needs" : "this request's amount";
    throw refuse(`that transaction credits ${fromAtomic(credit.amountAtomic, row.token)} ${row.token}, not ${fromAtomic(due, row.token)} ${row.token} (${what}); only an exact match can be confirmed`);
  }
  if (tx.blockTime == null) throw refuse("that transaction has no block time yet; try again in a minute");
  if (Number(tx.blockTime) < Date.parse(row.createdAt) / 1000 - CREATED_SKEW_SECONDS) {
    throw refuse(`that transaction landed at ${credit.at}, before this request was made (${row.createdAt}), so it can't be its payment`);
  }

  // A payment that names an Owed reference belongs to that request by Owed's rules; it is never re-attributed.
  const keys = accountKeys(tx);
  const { attributed, references } = await attributedOf([input.transaction], keys);
  const named = references.find((r) => r.request_id !== row.id) ?? references[0];
  if (named) {
    throw refuse(named.request_id === row.id
      ? "that transaction carries this request's own reference, so the normal status check counts it; check the request again instead"
      : `that transaction carries the reference of another Owed request (${named.request_id}), so it pays that one`);
  }
  if (attributed.length > 0) throw refuse(`that transaction already settles Owed request ${attributed[0].request_id}`);

  // Lock the row (x402 and cancel take the same lock), write the match only if the request is still exactly as
  // checked, then mark it paid. One transaction: either both writes land or neither does.
  const expectedStatus = covers === "full" ? ["open", "cancelled"] : ["underpaid"];
  try {
    const [, inserted, updated] = await transaction([
      { text: `select id from requests where id = $1 for update`, params: [row.id] },
      {
        text: `insert into request_matches (request_id, signature, covers, payer, amount_atomic, paid_at, slot,
                 confirmed_by, confirm_message, confirm_signature)
               select $1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10
                where exists (select 1 from requests
                               where id = $1 and status = any($11::text[]) and paid_signature is not distinct from $12::text)
                  and not exists (select 1 from requests where paid_signature = $2)
                  and not exists (select 1 from x402_receipts where signature = $2 and state in ('settling', 'settled', 'verified', 'unknown'))
               returning request_id`,
        params: [row.id, input.transaction, covers, credit.payer, credit.amountAtomic, credit.at, BigInt(credit.slot),
          row.recipient, input.signedMessage, input.signature.trim(), expectedStatus, checked.paidSignature],
      },
      {
        text: `update requests
                  set status = 'paid',
                      paid_signature = case when $2 = 'full' then $3 else paid_signature end,
                      paid_payer = case when $2 = 'full' then $4 else paid_payer end,
                      paid_amount_atomic = case when $2 = 'full' then $5::numeric else paid_amount_atomic + $5::numeric end,
                      paid_at = case when $2 = 'full' then $6::timestamptz else paid_at end,
                      paid_rail = case when $2 = 'full' then 'matched' else paid_rail end,
                      is_team = case when $2 = 'full' then ${isTeamSql("$7", "$4::text")} else is_team end -- W2-F (lib/team.ts)
                where id = $1 and exists (select 1 from request_matches where request_id = $1 and signature = $3)
                returning ${COLUMNS}`,
        params: [row.id, covers, input.transaction, credit.payer, credit.amountAtomic, credit.at, teamWallets()],
      },
    ]);
    if (inserted.length > 0 && updated.length > 0) {
      watchSoon();
      return { row: fromRow(updated[0]), already: false };
    }
  } catch (e) {
    if (isUniqueViolation(e, "request_matches_signature_key")) throw refuse("that transaction is already matched to another Owed request");
    if (isUniqueViolation(e, "request_matches_pkey")) {
      const fresh = await getRequest(row.id);
      if (fresh?.match?.signature === input.transaction) return { row: fresh, already: true };
      throw refuse("this request was just matched to another transaction");
    }
    if (isUniqueViolation(e, "requests_paid_signature_key")) throw refuse("that transaction already settles another Owed request");
    throw e;
  }
  // The request changed between the check and the write (paid, cancelled or matched meanwhile).
  const fresh = (await getRequest(row.id)) ?? checked;
  if (fresh.match?.signature === input.transaction) return { row: fresh, already: true };
  if (fresh.status === "paid") throw refuse(`this request can't take a match: ${describePaid(fresh)}`);
  throw refuse("this request changed while the match was being checked; check it again and sign a fresh message");
}

// ---- ask_for_rest: a linked request for exactly what an underpaid request still owes ----

export interface RestOutcome {
  parent: RequestRow;
  rest: RequestRow;
  /** The rest had been asked before; this is that request. */
  already: boolean;
}

/** Chain check before asking for the rest, so the remainder is current. Under the plugin's API timeout. */
export const REST_CHAIN_BUDGET_MS = 2500;

export async function askForRest(id: string, source: "plugin" | "web", rpc: RpcOptions = { deadline: Date.now() + REST_CHAIN_BUDGET_MS }): Promise<RestOutcome> {
  let parent = await getRequest(id);
  if (!parent) throw new ApiError("not_found", "no request with this id");
  if (parent.restRequest) return existingRest(parent);
  if (parent.status === "underpaid" || parent.status === "open") {
    try {
      [parent] = await settleFromChain([parent], rpc);
    } catch {
      // Ask from the stored state: an underpaid request only becomes paid by a full payment, which the
      // pay page and status checks still find; the remainder asked here is what was owed when it was stored.
    }
  }
  if (parent.status !== "underpaid") {
    throw refuse(parent.status === "paid"
      ? "this request is already paid in full; there is no rest to ask for"
      : `only an underpaid request has a rest to ask for, and this one is ${parent.status}`);
  }
  const { due } = amountDue(parent);
  if (due <= 0n) throw refuse("this request has nothing left to pay");
  try {
    const rest = await createRequest({
      recipient: parent.recipient,
      token: parent.token,
      amountAtomic: due,
      payerName: parent.payerName,
      forText: parent.forText,
      note: null,
      requesterName: parent.requesterName,
      flags: parent.flags,
      source,
      chain: parent.chain ?? "solana",
      restOf: parent.id,
    });
    return { parent: (await getRequest(parent.id)) ?? parent, rest, already: false };
  } catch (e) {
    if (isUniqueViolation(e, "requests_rest_of_key")) {
      const fresh = await getRequest(parent.id);
      if (fresh?.restRequest) return existingRest(fresh);
    }
    throw e;
  }
}

async function existingRest(parent: RequestRow): Promise<RestOutcome> {
  const rest = await getRequest(parent.restRequest!.id);
  if (!rest) throw new ApiError("upstream_unavailable", "the follow-up request couldn't be read; try again shortly");
  return { parent, rest, already: true };
}
