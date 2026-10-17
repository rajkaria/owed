import type { ReactNode } from "react";
import { AgentIcon, ChatIcon, LayersIcon, QrIcon, WalletIcon } from "@/components/icons";
import { Container } from "./ui";

// Not customer logos: a quiet row of what Owed works with, in words, with generic icons.

// Phantom is named because a Phantom scan paid a production request (docs/FACTS.md, Mainnet transactions).
const ITEMS: { icon: ReactNode; label: string; detail: string }[] = [
  { icon: <ChatIcon />, label: "Claude", detail: "as an MCP connector" },
  { icon: <ChatIcon />, label: "ChatGPT", detail: "as an MCP connector" },
  { icon: <QrIcon />, label: "Phantom", detail: "scan the QR code" },
  { icon: <WalletIcon />, label: "Any Solana Pay wallet", detail: "from the link" },
  { icon: <LayersIcon />, label: "Base wallets", detail: "USDC on Base" },
  { icon: <AgentIcon />, label: "PayBox agents", detail: "pay a link with a passkey" },
];

export function TrustStrip() {
  return (
    <section aria-label="Works with" className="border-b border-line bg-bg">
      <Container className="flex flex-col gap-4 py-7 md:flex-row md:items-center md:gap-8">
        <p className="shrink-0 font-mono text-xs font-medium uppercase tracking-[0.14em] text-muted">Works with</p>
        <ul className="flex flex-wrap gap-x-8 gap-y-3">
          {ITEMS.map((item) => (
            <li key={item.label} className="flex items-center gap-2.5 text-sm">
              <span className="text-muted [&_svg]:size-[18px]">{item.icon}</span>
              <span>
                <span className="font-semibold">{item.label}</span>
                <span className="hidden text-muted sm:inline"> · {item.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
