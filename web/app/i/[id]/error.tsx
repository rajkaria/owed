"use client";

import { MessagePage } from "@/components/message-page";

export default function InvoiceError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <MessagePage
      eyebrow="Invoice"
      title="This invoice didn't load"
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
      <p>Something went wrong on our side while reading this invoice. Your money hasn&apos;t moved. Try again in a moment.</p>
    </MessagePage>
  );
}
