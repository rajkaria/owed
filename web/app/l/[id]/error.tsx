"use client";

import { MessagePage } from "@/components/message-page";

export default function LedgerError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <MessagePage
      eyebrow="Group ledger"
      title="This ledger didn't load"
      action={
        <button
          type="button"
          onClick={() => retry()}
          className="inline-flex h-12 items-center rounded-xl bg-fg px-5 font-semibold text-bg hover:opacity-90"
        >
          Try again
        </button>
      }
    >
      <p>Something went wrong on our side while reading this ledger. No money has moved. Try again in a moment.</p>
    </MessagePage>
  );
}
