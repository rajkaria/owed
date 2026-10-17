// Decodes and checks the unsigned Solana transaction inside a PayBox proposal, without dependencies.
// Layout rules come from SPEC §4: legacy tx, fee payer = sender, ≤ 1,232 bytes, optional idempotent ATA create,
// optional memo, then transferChecked (USDC) or SystemProgram.transfer (SOL) with reference keys appended as
// read-only non-signers. Placeholder blockhash 1111…1111 (PayBox fills the real one).
import { base58Encode, fromAtomic, TOKEN_DECIMALS, toAtomic, USDC_MINT } from "../../contract/shapes.mjs";

export const MAX_TX_BYTES = 1232;
export const PLACEHOLDER_BLOCKHASH = "11111111111111111111111111111111";
export const PROPOSAL_KEY = "io.paybox/transactionProposal";
export const PROGRAMS = {
  "11111111111111111111111111111111": "System",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "AssociatedToken",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: "MemoV1",
  ComputeBudget111111111111111111111111111111: "ComputeBudget",
};

class Reader {
  constructor(bytes) { this.bytes = bytes; this.offset = 0; }
  u8() {
    if (this.offset >= this.bytes.length) throw new Error(`truncated at byte ${this.offset}`);
    return this.bytes[this.offset++];
  }
  take(length) {
    if (this.offset + length > this.bytes.length) throw new Error(`truncated: need ${length} bytes at byte ${this.offset}`);
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
  compactU16() {
    let value = 0;
    for (let index = 0; index < 3; index += 1) {
      const byte = this.u8();
      value |= (byte & 0x7f) << (7 * index);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error("compact-u16 longer than 3 bytes");
  }
}

const u64 = (data, offset) => {
  if (data.length < offset + 8) throw new Error("instruction data too short for u64");
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(data[offset + index]);
  return value;
};
const u32 = (data, offset) => data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] * 2 ** 24);

/** Wire-format legacy transaction → accounts with signer/writable flags and raw instructions. Throws on bad bytes. */
export function decodeTransaction(bytes) {
  const reader = new Reader(bytes);
  const signatureCount = reader.compactU16();
  const signatures = [];
  for (let index = 0; index < signatureCount; index += 1) signatures.push(reader.take(64));
  if (reader.offset < bytes.length && bytes[reader.offset] & 0x80) {
    throw new Error(`versioned transaction (v${bytes[reader.offset] & 0x7f}); Owed builds legacy transactions only`);
  }
  const header = { requiredSignatures: reader.u8(), readonlySigned: reader.u8(), readonlyUnsigned: reader.u8() };
  const keyCount = reader.compactU16();
  const keys = [];
  for (let index = 0; index < keyCount; index += 1) keys.push(base58Encode(reader.take(32)));
  const blockhash = base58Encode(reader.take(32));
  const accounts = keys.map((address, index) => ({
    address,
    signer: index < header.requiredSignatures,
    writable: index < header.requiredSignatures
      ? index < header.requiredSignatures - header.readonlySigned
      : index < keyCount - header.readonlyUnsigned,
  }));
  const instructionCount = reader.compactU16();
  const instructions = [];
  for (let index = 0; index < instructionCount; index += 1) {
    const programIndex = reader.u8();
    const accountIndexes = [];
    const accountCount = reader.compactU16();
    for (let entry = 0; entry < accountCount; entry += 1) accountIndexes.push(reader.u8());
    const data = Uint8Array.from(reader.take(reader.compactU16()));
    for (const accountIndex of [programIndex, ...accountIndexes]) {
      if (accountIndex >= keyCount) throw new Error(`instruction ${index} points at account ${accountIndex} of ${keyCount}`);
    }
    const program = keys[programIndex];
    instructions.push({ program, programName: PROGRAMS[program] ?? null, accounts: accountIndexes.map((accountIndex) => accounts[accountIndex]), data });
  }
  if (reader.offset !== bytes.length) throw new Error(`${bytes.length - reader.offset} trailing bytes after the message`);
  return {
    size: bytes.length, signatureCount, unsigned: signatures.every((signature) => signature.every((byte) => byte === 0)),
    header, accounts, blockhash, instructions,
  };
}

/** Human meaning of the instructions Owed is allowed to emit. Unknown ones come back as { type: "unknown" }. */
export function describeInstruction(instruction) {
  const { programName, accounts, data } = instruction;
  const address = (index) => accounts[index]?.address ?? null;
  if (programName === "System" && data.length >= 12 && u32(data, 0) === 2) {
    const lamports = u64(data, 4);
    return { type: "sol_transfer", from: address(0), to: address(1), atomic: lamports, amount: fromAtomic(lamports, 9), extra: accounts.slice(2) };
  }
  if ((programName === "Token" || programName === "Token-2022") && data[0] === 12 && data.length >= 10) {
    const atomic = u64(data, 1);
    return {
      type: "spl_transfer_checked", source: address(0), mint: address(1), destination: address(2), owner: address(3),
      atomic, decimals: data[9], amount: fromAtomic(atomic, data[9]), extra: accounts.slice(4),
    };
  }
  if ((programName === "Token" || programName === "Token-2022") && data[0] === 3) return { type: "spl_transfer_unchecked" };
  if (programName === "AssociatedToken" && (data.length === 0 || data[0] === 0 || data[0] === 1)) {
    return { type: data[0] === 1 ? "ata_create_idempotent" : "ata_create", payer: address(0), ata: address(1), owner: address(2), mint: address(3) };
  }
  if (programName === "Memo" || programName === "MemoV1") return { type: "memo", text: Buffer.from(data).toString("utf8"), signers: accounts.map((account) => account.address) };
  if (programName === "ComputeBudget") return { type: "compute_budget", op: data[0] };
  return { type: "unknown", program: instruction.program };
}

/**
 * Checks a tools/call structuredContent that carries a PayBox proposal. `sender` is the fee payer the tx must use;
 * `expected` (from the Solana Pay URL being paid) adds recipient/amount/token/reference/memo checks, and
 * `ataFor(owner, mint)` (optional, needs web3.js) lets USDC destinations be matched to the recipient.
 */
export function inspectProposal(structuredContent, { sender, expected, ataFor, now = Date.now() } = {}) {
  const errors = [];
  const warnings = [];
  const proposal = structuredContent?.[PROPOSAL_KEY];
  if (!proposal) return { errors: ["no PayBox proposal in structuredContent"], warnings, summary: null };
  if (proposal.version !== "1") errors.push(`proposal version ${JSON.stringify(proposal.version)}, expected "1"`);
  const expires = Date.parse(proposal.expiresAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(proposal.expiresAt ?? "")) errors.push("expiresAt must be a whole-second UTC timestamp");
  else if (expires <= now || expires > now + 300_000) errors.push(`expiresAt ${proposal.expiresAt} is not within the next 5 minutes`);
  if (proposal.kind !== "solana") {
    return { errors, warnings, summary: { kind: proposal.kind, chain: proposal.chain, request: proposal.request, payment: proposal.payment } };
  }
  if (proposal.chain !== "solana:mainnet") errors.push(`chain ${proposal.chain}, expected solana:mainnet`);
  const base64 = proposal.transaction?.transactionBase64 ?? "";
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.toString("base64") !== base64) return { errors: [...errors, "transactionBase64 is not canonical padded base64"], warnings, summary: null };

  let tx;
  try {
    tx = decodeTransaction(bytes);
  } catch (error) {
    return { errors: [...errors, `transaction does not decode: ${error.message}`], warnings, summary: { bytes: bytes.length } };
  }
  if (tx.size > MAX_TX_BYTES) errors.push(`${tx.size} bytes > ${MAX_TX_BYTES}`);
  if (tx.header.requiredSignatures !== 1) errors.push(`${tx.header.requiredSignatures} required signatures, expected 1 (the sender)`);
  if (tx.signatureCount !== tx.header.requiredSignatures) errors.push(`${tx.signatureCount} signature slots for ${tx.header.requiredSignatures} required signatures`);
  if (!tx.unsigned) errors.push("transaction carries a non-zero signature; proposals must be unsigned");
  const feePayer = tx.accounts[0]?.address ?? null;
  if (sender && feePayer !== sender) errors.push(`fee payer ${feePayer}, expected the sender ${sender}`);
  if (tx.blockhash !== PLACEHOLDER_BLOCKHASH) warnings.push(`blockhash ${tx.blockhash} is not the placeholder ${PLACEHOLDER_BLOCKHASH}`);

  const described = tx.instructions.map(describeInstruction);
  for (const [index, entry] of described.entries()) {
    if (entry.type === "unknown") warnings.push(`instruction ${index} calls unexpected program ${entry.program}`);
    if (entry.type === "spl_transfer_unchecked") errors.push(`instruction ${index} is Token transfer; use transferChecked`);
    if (entry.type === "ata_create") warnings.push(`instruction ${index} is a non-idempotent ATA create; it fails if the account exists`);
  }
  const transfers = described.filter((entry) => entry.type === "sol_transfer" || entry.type === "spl_transfer_checked");
  if (transfers.length !== 1) errors.push(`${transfers.length} transfer instructions, expected exactly 1`);
  const transfer = transfers[0];
  const memos = described.filter((entry) => entry.type === "memo");
  const ataCreate = described.find((entry) => entry.type === "ata_create_idempotent" || entry.type === "ata_create");

  let summary = null;
  if (transfer) {
    for (const account of transfer.extra) {
      if (account.signer || account.writable) errors.push(`reference ${account.address} must be a read-only non-signer`);
    }
    const isSol = transfer.type === "sol_transfer";
    const token = isSol ? "SOL" : transfer.mint === USDC_MINT ? "USDC" : transfer.mint;
    summary = {
      bytes: tx.size, feePayer, blockhash: tx.blockhash, instructions: described.map((entry) => entry.type),
      transfer: {
        token, amount: transfer.amount, atomic: transfer.atomic.toString(),
        from: isSol ? transfer.from : transfer.owner, destination: isSol ? transfer.to : transfer.destination,
        destinationOwner: isSol ? transfer.to : ataCreate && ataCreate.ata === transfer.destination ? ataCreate.owner : null,
        references: transfer.extra.map((account) => account.address),
      },
      memo: memos[0]?.text ?? null,
      createsRecipientAta: Boolean(ataCreate),
    };
    if (!isSol && token === "USDC" && transfer.decimals !== TOKEN_DECIMALS.USDC) errors.push(`USDC transfer with ${transfer.decimals} decimals`);
    if (sender && summary.transfer.from !== sender) errors.push(`transfer authority ${summary.transfer.from}, expected the sender ${sender}`);
  }

  if (expected && summary) {
    const want = summary.transfer;
    if (expected.token && want.token !== expected.token) errors.push(`pays ${want.token}, request is for ${expected.token}`);
    if (expected.amount && expected.token) {
      const decimals = TOKEN_DECIMALS[expected.token];
      if (decimals !== undefined && BigInt(want.atomic) !== toAtomic(expected.amount, decimals)) errors.push(`pays ${want.amount} ${want.token}, request is for ${expected.amount}`);
    }
    if (expected.recipient) {
      if (want.token === "SOL" && want.destination !== expected.recipient) errors.push(`SOL goes to ${want.destination}, request recipient is ${expected.recipient}`);
      if (want.token !== "SOL") {
        if (want.destinationOwner && want.destinationOwner !== expected.recipient) errors.push(`token account owner ${want.destinationOwner}, request recipient is ${expected.recipient}`);
        const derived = ataFor && expected.splToken ? ataFor(expected.recipient, expected.splToken) : null;
        if (derived && derived !== want.destination) errors.push(`destination ${want.destination} is not the recipient's associated token account ${derived}`);
        if (!derived && !want.destinationOwner) warnings.push("could not confirm the destination token account belongs to the recipient");
      }
    }
    for (const reference of expected.references ?? []) {
      if (!want.references.includes(reference)) errors.push(`reference ${reference} from the request is missing`);
    }
    if (expected.memo && summary.memo !== expected.memo) errors.push(`memo ${JSON.stringify(summary.memo)}, request memo is ${JSON.stringify(expected.memo)}`);
  }
  return { errors, warnings, summary };
}
