import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { ArrowRightIcon, BoxIcon, CopyIcon, GlobeIcon, HashIcon, LockIcon } from "@/components/icons";
import { CodeBlock } from "./code-block";
import { DevTabs } from "./dev-tabs";
import { FIXTURES_URL, LLMS_URL, PAYBOX_MCP_URL, REPO_URL, TEAM_WALLET, TESTING_URL } from "./site";
import { Container, SectionHeading } from "./ui";

// The developer band. Samples follow contract/fixtures (create-request, status) and the plugin's
// ask_for_money schemas, with the production host. x402 copy is shown only when NEXT_PUBLIC_OWED_X402_PUBLIC is "1"
// (the pay page uses the same flag): nothing about x402 until a mainnet x402 settle is in docs/FACTS.md.

const ORIGIN = "https://www.getowed.xyz";
const ID = "JArQ6g9JvoWr";
const REFERENCE = "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_PAY_URL = `solana:${TEAM_WALLET}?amount=15&spl-token=${USDC_MINT}&reference=${REFERENCE}&label=Raj&message=dinner&memo=owed%3A${ID}`;
/** What the pay page's QR encodes (lib/view/request-view.ts): a Solana Pay transaction request served by Owed. */
const TX_REQUEST_URL = `solana:${ORIGIN}/api/v1/pay/${ID}`;
/** A Base request's pay_url (contract/fixtures/base.create-request.res.json): EIP-681, USDC on chain 8453. */
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_RECIPIENT = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const BASE_PAY_URL = `ethereum:${BASE_USDC}@8453/transfer?address=${BASE_RECIPIENT}&uint256=15000000`;

const MCP_CALL = `{
  "name": "ask_for_money",
  "arguments": {
    "recipient": "${TEAM_WALLET}",
    "amount": "15",
    "token": "USDC",
    "payer_name": "Priya",
    "for": "dinner"
  }
}`;

const MCP_RESULT = `{
  "id": "${ID}",
  "mode": "hosted",
  "link": "${ORIGIN}/r/${ID}",
  "solana_pay_url": "solana:${TEAM_WALLET}?amount=15&…",
  "qr_url": "${ORIGIN}/api/qr/${ID}.png",
  "reference": "${REFERENCE}",
  "recipient": "${TEAM_WALLET}",
  "amount": "15",
  "token": "USDC",
  "payer_name": "Priya",
  "for": "dinner",
  "share_text": "Hey Priya! Your share for \\"dinner\\" is 15 USDC. Pay with any Solana wallet here: ${ORIGIN}/r/${ID}",
  "status": "open",
  "screening": "clear"
}`;

const REST_CREATE = `curl -X POST ${ORIGIN}/api/v1/requests \\
  -H 'content-type: application/json' \\
  -d '{
    "recipient": "${TEAM_WALLET}",
    "amount": "15",
    "token": "USDC",
    "payer_name": "Priya",
    "for": "dinner"
  }'`;

/** The pay page shows x402 lines under the same flag; the landing follows it so the two never disagree. */
const X402_PUBLIC = process.env.NEXT_PUBLIC_OWED_X402_PUBLIC === "1";

const REST_CREATE_RES = `{
  "id": "${ID}",
  "link": "${ORIGIN}/r/${ID}",
  "solana_pay_url": "solana:${TEAM_WALLET}?amount=15&…",
  "qr_url": "${ORIGIN}/api/qr/${ID}.png",
  "reference": "${REFERENCE}",${X402_PUBLIC ? `\n  "x402_url": "${ORIGIN}/x/${ID}",` : ""}
  "created_at": "2026-10-17T05:00:00Z",
  "flags": []
}`;

const REST_STATUS = `curl -X POST ${ORIGIN}/api/v1/status \\
  -H 'content-type: application/json' \\
  -d '{ "ids": ["${ID}", "Bq3wL8mNc2", "111111111111"] }'`;

const REST_STATUS_RES = `{
  "results": [
    {
      "id": "${ID}",
      "status": "paid",
      "amount_requested": "15",
      "token": "USDC",
      "amount_paid": "15",
      "payer": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      "signature": "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv",
      "paid_at": "2026-10-17T05:00:09Z"
    },
    { "id": "Bq3wL8mNc2", "status": "open", "amount_requested": "4.5", "token": "USDC" },
    { "id": "111111111111", "status": "not_found" }
  ]
}`;

const RAILS_COMMON = `# 1. The QR on the pay page: a Solana Pay transaction request. The wallet
#    fetches a transaction Owed built (reference and memo inside) and only signs it.
${TX_REQUEST_URL}

# 2. The same request as a Solana Pay transfer URL, for agents and deep links
${SOLANA_PAY_URL}

# 3. A request on Base: an EIP-681 link a Base wallet opens (USDC, chain 8453)
${BASE_PAY_URL}`;

const RAILS_SOLANA_PAY = RAILS_COMMON;

const RAILS_X402 = `${RAILS_COMMON}

# 4. Agents paying over HTTP: the same request as an x402 challenge
curl -i ${ORIGIN}/x/${ID}
HTTP/2 402
# The challenge pays the request's recipient and amount in USDC on Solana mainnet.`;

function Prose({ children }: { children: ReactNode }) {
  return <p className="max-w-2xl text-pretty leading-relaxed text-ink-muted">{children}</p>;
}

function McpPanel() {
  return (
    <div className="flex flex-col gap-6">
      <Prose>
        Owed is a PayBox plugin. Add PayBox to your agent as an MCP connector and turn Owed on; your agent then calls Owed&apos;s
        tools through PayBox, and every payment it proposes comes back unsigned for you to approve with a passkey.
      </Prose>
      <div className="flex max-w-xl flex-wrap items-center justify-between gap-2 rounded-xl border border-ink-line bg-ink-sunken py-1.5 pl-4 pr-1.5">
        <span className="min-w-0">
          <span className="block font-mono text-[0.7rem] uppercase tracking-wider text-ink-muted">MCP connector</span>
          <code className="block break-all font-mono text-sm text-ink-fg">{PAYBOX_MCP_URL}</code>
        </span>
        <CopyButton
          text={PAYBOX_MCP_URL}
          label="Copy"
          icon={<CopyIcon className="shrink-0" width={16} height={16} />}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-ink-accent px-3 text-sm font-semibold text-ink hover:brightness-105"
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <CodeBlock title="what your agent calls" lang="json" code={MCP_CALL} />
        <CodeBlock title="what it gets back" lang="json" code={MCP_RESULT} />
      </div>
    </div>
  );
}

function RestPanel() {
  return (
    <div className="flex flex-col gap-6">
      <Prose>
        The same requests over plain JSON, no API key. Create a request, hand out the link, then ask for the status of up to
        20 ids at once; the answer is checked against the chain. Errors are{" "}
        <code className="font-mono text-[0.9em] text-ink-fg">{`{"error":{"code","message"}}`}</code>.
      </Prose>
      <div className="grid gap-4 lg:grid-cols-2">
        <CodeBlock title="POST /api/v1/requests" lang="shell" code={REST_CREATE} />
        <CodeBlock title="201 Created" lang="json" code={REST_CREATE_RES} />
        <CodeBlock title="POST /api/v1/status" lang="shell" code={REST_STATUS} />
        <CodeBlock title="200 OK" lang="json" code={REST_STATUS_RES} />
      </div>
      <p className="text-sm text-ink-muted">
        Also <code className="font-mono text-ink-fg">GET /api/v1/requests/&lt;id&gt;</code> for one request&apos;s terms, status and
        payment, and <code className="font-mono text-ink-fg">GET /api/v1/stats</code> for the count and USDC volume of paid requests.
      </p>
    </div>
  );
}

function RailsPanel() {
  if (!X402_PUBLIC) {
    return (
      <div className="flex flex-col gap-6">
        <Prose>
          Every request is a standard link, so a wallet pays it with no Owed account. The QR asks the wallet to sign a
          transaction Owed built, so the request&apos;s reference is always in it; the transfer URL carries the amount, token,
          recipient and reference for everything else. A Base request is an EIP-681 link instead.
        </Prose>
        <CodeBlock title="one request, standard links" lang="shell" code={RAILS_SOLANA_PAY} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <Prose>
        Every request is a standard link, so a wallet pays it with no Owed account: the QR asks the wallet to sign a
        transaction Owed built with the reference inside, and a Base request is an EIP-681 link. For agents,{" "}
        <code className="font-mono text-[0.9em] text-ink-fg">GET /x/&lt;id&gt;</code> answers HTTP 402 with an x402 challenge
        that pays the same recipient and amount; <code className="font-mono text-[0.9em] text-ink-fg">pay_link</code> with
        rail <code className="font-mono text-[0.9em] text-ink-fg">x402</code> checks the live challenge matches the request
        before proposing it, for payers without SOL for fees.
      </Prose>
      <CodeBlock title="one request, every rail" lang="shell" code={RAILS_X402} />
    </div>
  );
}

const PRINCIPLES: { icon: ReactNode; title: string; body: ReactNode }[] = [
  {
    icon: <LockIcon />,
    title: "Unsigned proposals only",
    body: "Owed never signs anything. pay_link returns an unsigned Solana transaction and you approve it with a passkey in PayBox. Decoded production proposals hold one transfer to the recipient and nothing to Owed.",
  },
  {
    icon: <BoxIcon />,
    title: "Fresh sandbox, 10-second budget",
    body: "Every call runs in a fresh sandbox with a 10 s budget and HTTPS to an exact list of hosts: Owed, Solana RPC and two DNS resolvers. No secrets in the code, no network at startup, byte-identical builds.",
  },
  {
    icon: <HashIcon />,
    title: "Ids commit to the terms",
    body: (
      <>
        A request id is the last 12 base58 characters of sha256 over the recipient, asset, amount and reference.{" "}
        <code className="font-mono text-[0.9em] text-ink-fg">pay_link</code> recomputes it from what the server returns and
        refuses a mismatch, so a server can&apos;t swap the payee behind a shared link.
      </>
    ),
  },
  {
    icon: <GlobeIcon />,
    title: "DNS-verified payees",
    body: (
      <>
        A requester proves a domain with a TXT record <code className="font-mono text-[0.9em] text-ink-fg">_owed.&lt;domain&gt;</code>{" "}
        = <code className="font-mono text-[0.9em] text-ink-fg">owed-pay=&lt;wallet&gt;</code>. The plugin reads it over DNS over
        HTTPS itself and refuses a wallet the domain doesn&apos;t list.
      </>
    ),
  },
];

const LINKS = [
  { href: LLMS_URL, label: "Docs for agents", detail: "/llms.txt" },
  { href: REPO_URL, label: "Source", detail: "github.com/rajkaria/owed" },
  { href: TESTING_URL, label: "How it is tested", detail: "docs/TESTING.md" },
  { href: FIXTURES_URL, label: "API fixtures", detail: "contract/fixtures" },
];

export function Developers() {
  return (
    <section
      id="developers"
      aria-labelledby="developers-title"
      className="relative isolate scroll-mt-20 overflow-hidden bg-ink py-20 text-ink-fg md:py-28"
    >
      <div aria-hidden="true" className="bg-grid mask-fade-b pointer-events-none absolute inset-0 opacity-60" />
      <div aria-hidden="true" className="bg-glow pointer-events-none absolute -top-48 right-[-10%] h-[32rem] w-[32rem] rounded-full opacity-70 blur-3xl" />
      <Container className="relative">
        <SectionHeading
          id="developers-title"
          ink
          eyebrow="Developers"
          title="Built for agents and the people who build them."
          lede="One plugin, three ways in. Everything below is live on Solana mainnet; the samples are the contract fixtures the plugin and the API are both tested against."
        />
        <div className="mt-12">
          <DevTabs
            tabs={[
              { id: "mcp", label: "MCP", panel: <McpPanel /> },
              { id: "rest", label: "REST", panel: <RestPanel /> },
              { id: "rails", label: X402_PUBLIC ? "Solana Pay / Base / x402" : "Solana Pay / Base", panel: <RailsPanel /> },
            ]}
          />
        </div>

        <ul className="mt-16 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PRINCIPLES.map((p) => (
            <li key={p.title} className="rounded-2xl border border-ink-line bg-ink-surface p-5">
              <span className="grid size-9 place-items-center rounded-lg bg-ink-accent-soft text-ink-accent [&_svg]:size-[18px]">{p.icon}</span>
              <h3 className="mt-4 font-semibold text-ink-fg">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{p.body}</p>
            </li>
          ))}
        </ul>

        <ul className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                className="group flex items-center justify-between gap-3 rounded-xl border border-ink-line px-4 py-3 text-sm hover:border-ink-accent/40 hover:bg-ink-accent-soft"
              >
                <span className="min-w-0">
                  <span className="block font-semibold text-ink-fg">{l.label}</span>
                  <span className="block truncate font-mono text-xs text-ink-muted">{l.detail}</span>
                </span>
                <ArrowRightIcon width={16} height={16} className="shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-ink-accent" />
              </a>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
