"use client";

import { useEffect, useRef, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { AgentIcon, AlertIcon, CheckIcon, CopyIcon, ExternalIcon, WalletIcon } from "@/components/icons";
import { ALERTS_MESSAGE_MAX_AGE_MS, alertsMessage } from "@/lib/alerts/grammar";
import { discoverWallets, toHex, type BrowserWallet } from "./browser-wallet";

type Channel = "telegram" | "email";
type Method = "browser" | "paybox";

interface Created {
  id: string;
  wallet: string;
  channel: Channel;
  expires_at: string;
  next: string;
  telegram?: { bot: string; code: string; link: string };
  email?: { address: string };
}

const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const card = "rounded-2xl border border-line bg-surface p-5 sm:p-6";
const label = "block text-sm font-semibold";
const input =
  "mt-2 block w-full rounded-xl border border-line bg-bg px-3.5 py-3 text-base outline-none transition-colors placeholder:text-muted focus:border-accent";
const primary =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-fg px-5 py-2 text-base font-semibold text-bg transition-opacity hover:opacity-90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50";
const secondary =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-line bg-surface px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-sunken active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50";

function errorText(json: unknown, status: number): string {
  const message = (json as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" && message ? message : `Owed answered HTTP ${status}; try again in a minute.`;
}

/** The browser's clock, read in event handlers and effects only. */
function clock(): number {
  return Date.now();
}

function minutesLeft(issuedAt: number, now: number): string {
  const left = Math.max(0, ALERTS_MESSAGE_MAX_AGE_MS - (now - issuedAt));
  const s = Math.ceil(left / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function AlertsSetup({ channels, serverNow }: { channels: Record<Channel, boolean>; serverNow: number }) {
  const [channel, setChannel] = useState<Channel>(channels.telegram ? "telegram" : "email");
  const [email, setEmail] = useState("");
  const [wallet, setWallet] = useState("");
  const [wallets, setWallets] = useState<BrowserWallet[]>([]);
  const [chosen, setChosen] = useState<string>("");
  const [method, setMethod] = useState<Method>("browser");
  const [pending, setPending] = useState<{ message: string; issuedAt: number } | null>(null);
  const [pasted, setPasted] = useState("");
  const [now, setNow] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  // Server clock minus this browser's, measured once on load: the signed time must be within Owed's 5 minutes.
  const offset = useRef(0);

  useEffect(() => {
    offset.current = serverNow - clock();
  }, [serverNow]);

  useEffect(() => discoverWallets(setWallets), []);

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setNow(clock()), 1000);
    return () => clearInterval(timer);
  }, [pending]);

  const trimmedWallet = wallet.trim();
  const walletOk = WALLET.test(trimmedWallet);
  const emailOk = channel !== "email" || EMAIL.test(email.trim());
  const browser = wallets.find((w) => w.key === chosen) ?? wallets[0] ?? null;
  const showBrowser = method === "browser" && wallets.length > 0;
  const expired = pending !== null && now !== null && now - pending.issuedAt >= ALERTS_MESSAGE_MAX_AGE_MS;

  function check(needWallet: boolean): boolean {
    if (!emailOk) {
      setError("Enter the email address alerts should go to.");
      return false;
    }
    if (needWallet && !walletOk) {
      setError("Enter the Solana wallet address your requests pay (32 to 44 letters and digits).");
      return false;
    }
    setError(null);
    return true;
  }

  async function submit(address: string, message: string, signature: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          wallet: address,
          signed_message: message,
          signature,
          channel,
          ...(channel === "email" && { email: email.trim() }),
        }),
        cache: "no-store",
      });
      const json = (await res.json().catch(() => null)) as Created | null;
      if (res.status === 201 && json) {
        setCreated(json);
        setPending(null);
        setPasted("");
      } else {
        setError(errorText(json, res.status));
      }
    } catch {
      setError("Couldn't reach Owed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function signWithBrowser() {
    if (!browser || !check(false)) return;
    setBusy(true);
    try {
      const shared = await browser.connect();
      let address = trimmedWallet;
      if (!address) {
        address = shared[0] ?? "";
        setWallet(address);
      } else if (!shared.includes(address)) {
        setError(
          shared.length
            ? `Your browser wallet is on ${shared[0]}, not the wallet entered above. Switch accounts in the wallet, clear the field to use that one, or sign with PayBox instead.`
            : "Your browser wallet didn't share an address. Unlock it and try again, or sign with PayBox instead.",
        );
        setBusy(false);
        return;
      }
      if (!WALLET.test(address)) {
        setError("Your browser wallet didn't share a Solana address. Sign with PayBox instead.");
        setBusy(false);
        return;
      }
      const message = alertsMessage(address, clock() + offset.current);
      const signature = await browser.signMessage(address, new TextEncoder().encode(message));
      await submit(address, message, toHex(signature));
    } catch (e) {
      const text = e instanceof Error && e.message ? e.message : "the wallet refused";
      setError(`Signing didn't finish: ${text}. You can try again, or sign with PayBox instead.`);
      setBusy(false);
    }
  }

  function newMessage() {
    if (!check(true)) return;
    const issuedAt = clock();
    setPending({ message: alertsMessage(trimmedWallet, issuedAt + offset.current), issuedAt });
    setNow(issuedAt);
    setPasted("");
  }

  function submitPasted() {
    if (!pending || !check(true)) return;
    if (!pasted.trim()) {
      setError("Paste the signature PayBox returned.");
      return;
    }
    void submit(trimmedWallet, pending.message, pasted.trim());
  }

  if (created) return <Done created={created} onAgain={() => setCreated(null)} />;

  const call = pending
    ? JSON.stringify({ credential_id: "<your Solana wallet credential>", intent: { op: "solanaMessage", address: trimmedWallet, message: pending.message } })
    : "";
  const prompt = pending
    ? `Use PayBox request_wallet_sign on my Solana wallet ${trimmedWallet} with intent {"op":"solanaMessage","address":"${trimmedWallet}","message":"${pending.message}"} and show me the signature it returns.`
    : "";

  return (
    <div className="mt-10 grid gap-5">
      <section aria-labelledby="where-title" className={card}>
        <h2 id="where-title" className="text-lg font-semibold">
          1. Where alerts go
        </h2>
        {channels.telegram && channels.email ? (
          <fieldset className="mt-4 grid gap-2 sm:grid-cols-2">
            <legend className="sr-only">Channel</legend>
            {(["telegram", "email"] as const).map((c) => (
              <label
                key={c}
                className="flex cursor-pointer items-center gap-3 rounded-xl border border-line px-4 py-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
              >
                <input type="radio" name="channel" value={c} checked={channel === c} onChange={() => setChannel(c)} className="accent-[var(--accent)]" />
                <span className="font-medium">{c === "telegram" ? "A Telegram chat" : "An email address"}</span>
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="mt-2 text-muted">{channels.telegram ? "A Telegram chat with Owed's bot." : "An email address."}</p>
        )}
        {channel === "email" && (
          <div className="mt-4">
            <label htmlFor="alert-email" className={label}>
              Email address
            </label>
            <input
              id="alert-email"
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className={input}
            />
            <p className="mt-2 text-sm text-muted">Owed emails a confirmation link first. Nothing is sent until it is confirmed.</p>
          </div>
        )}
      </section>

      <section aria-labelledby="wallet-title" className={card}>
        <h2 id="wallet-title" className="text-lg font-semibold">
          2. Your wallet
        </h2>
        <label htmlFor="alert-wallet" className={`${label} mt-4`}>
          Solana wallet address
        </label>
        <input
          id="alert-wallet"
          value={wallet}
          onChange={(e) => {
            setWallet(e.target.value);
            setPending(null);
          }}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          placeholder="The address your requests pay"
          className={`${input} font-mono text-sm`}
        />
        <p className="mt-2 text-sm text-muted">
          Alerts cover every request paying this wallet. With a browser wallet you can leave it empty: the wallet fills it in.
        </p>
      </section>

      <section aria-labelledby="sign-title" className={card}>
        <h2 id="sign-title" className="text-lg font-semibold">
          3. Sign to show the wallet is yours
        </h2>
        <p className="mt-2 text-muted">
          The signature proves you hold the wallet. It moves no money and approves nothing else, and Owed accepts it once,
          within 5 minutes.
        </p>
        <div role="tablist" aria-label="How to sign" className="mt-4 inline-flex rounded-xl bg-sunken p-1 text-sm font-medium">
          {(
            [
              ["browser", "Browser wallet", <WalletIcon key="w" width={16} height={16} />],
              ["paybox", "PayBox agent", <AgentIcon key="a" width={16} height={16} />],
            ] as const
          ).map(([m, text, icon]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={method === m}
              onClick={() => {
                setMethod(m);
                setError(null);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-muted aria-selected:bg-surface aria-selected:text-fg aria-selected:shadow-sm"
            >
              {icon}
              {text}
            </button>
          ))}
        </div>

        {method === "browser" &&
          (showBrowser ? (
            <div className="mt-5 grid gap-3">
              {wallets.length > 1 && (
                <div>
                  <label htmlFor="alert-browser-wallet" className={label}>
                    Wallet
                  </label>
                  <select id="alert-browser-wallet" value={browser?.key ?? ""} onChange={(e) => setChosen(e.target.value)} className={input}>
                    {wallets.map((w) => (
                      <option key={w.key} value={w.key}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <button type="button" onClick={signWithBrowser} disabled={busy} className={primary}>
                  <WalletIcon width={18} height={18} />
                  {busy ? "Waiting for the wallet…" : "Sign and turn on alerts"}
                </button>
              </div>
              <p className="text-sm text-muted">Your wallet shows the text it signs: &ldquo;Owed alerts for &lt;your wallet&gt; at &lt;the time&gt;&rdquo;.</p>
            </div>
          ) : (
            <p className="mt-5 rounded-xl bg-sunken px-4 py-3 text-sm leading-relaxed text-muted">
              No browser wallet that can sign messages was found on this device. Sign with your PayBox agent instead: it
              works from any device.
            </p>
          ))}

        {method === "paybox" && (
          <div className="mt-5 grid gap-4">
            {!pending || expired ? (
              <div>
                {expired && <p className="mb-3 text-sm text-warn">That message is more than 5 minutes old. Get a fresh one.</p>}
                <button type="button" onClick={newMessage} className={primary}>
                  Get the message to sign
                </button>
              </div>
            ) : (
              <>
                <div>
                  <p className={label}>The message</p>
                  <p className="mt-2 break-all rounded-xl bg-sunken px-3.5 py-3 font-mono text-sm">{pending.message}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <CopyButton text={pending.message} label="Copy the message" icon={<CopyIcon width={16} height={16} />} className={secondary} />
                    <CopyButton text={prompt} label="Copy a prompt for your agent" icon={<AgentIcon width={16} height={16} />} className={secondary} />
                  </div>
                </div>
                <div>
                  <p className={label}>The PayBox call your agent makes</p>
                  <p className="mt-2 break-all rounded-xl bg-sunken px-3.5 py-3 font-mono text-xs leading-relaxed">request_wallet_sign {call}</p>
                  <p className="mt-2 text-sm text-muted">
                    PayBox asks you to approve the signature, then returns it as a long hex string. Paste it below.
                  </p>
                </div>
                <div>
                  <label htmlFor="alert-signature" className={label}>
                    Signature
                  </label>
                  <textarea
                    id="alert-signature"
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                    rows={3}
                    spellCheck={false}
                    placeholder="The signature PayBox returned"
                    className={`${input} font-mono text-xs`}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" onClick={submitPasted} disabled={busy} className={primary}>
                    {busy ? "Checking…" : "Turn on alerts"}
                  </button>
                  <span className="text-sm text-muted tabular-nums">
                    Good for {minutesLeft(pending.issuedAt, now ?? pending.issuedAt)} more ·{" "}
                    <button type="button" onClick={newMessage} className="font-medium text-accent underline-offset-4 hover:underline">
                      new message
                    </button>
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <div aria-live="polite">
        {error && (
          <p role="alert" className="flex gap-3 rounded-xl border border-warn-line bg-warn-soft px-4 py-3.5 text-sm leading-relaxed">
            <AlertIcon className="mt-0.5 shrink-0 text-warn" />
            <span>{error}</span>
          </p>
        )}
      </div>
    </div>
  );
}

function Done({ created, onAgain }: { created: Created; onAgain: () => void }) {
  const until = new Date(created.expires_at);
  const time = Number.isNaN(until.getTime()) ? null : until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <section aria-labelledby="done-title" className={`${card} mt-10`}>
      <p className="inline-flex items-center gap-2 text-sm font-medium text-paid">
        <CheckIcon width={16} height={16} />
        Signature accepted
      </p>
      {created.telegram ? (
        <>
          <h2 id="done-title" className="mt-2 text-2xl font-semibold tracking-tight">
            Now open Telegram and press Start
          </h2>
          <p className="mt-3 leading-relaxed text-muted">
            The link opens a chat with @{created.telegram.bot}. Press Start and the bot replies naming wallet{" "}
            <span className="break-all font-mono text-sm text-fg">{created.wallet}</span>. The link works once
            {time ? `, until ${time}` : ", for 15 minutes"}.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <a href={created.telegram.link} target="_blank" rel="noopener noreferrer" className={primary}>
              Open Telegram
              <ExternalIcon width={18} height={18} />
            </a>
            <CopyButton text={created.telegram.link} label="Copy the link" icon={<CopyIcon width={16} height={16} />} className={secondary} />
          </div>
          <p className="mt-5 text-sm leading-relaxed text-muted">
            On another device? Send <span className="font-mono text-fg">/start {created.telegram.code}</span> to @{created.telegram.bot}.
            Send /stop in that chat any time to turn alerts off.
          </p>
        </>
      ) : (
        <>
          <h2 id="done-title" className="mt-2 text-2xl font-semibold tracking-tight">
            Check your email
          </h2>
          <p className="mt-3 leading-relaxed text-muted">
            Owed sent a confirmation link to <span className="text-fg">{created.email?.address}</span>. Press it within 24
            hours; nothing is sent to that address until you do. Every alert email has a one-click unsubscribe link.
          </p>
        </>
      )}
      <button type="button" onClick={onAgain} className={`${secondary} mt-6`}>
        Link another chat or wallet
      </button>
    </section>
  );
}
