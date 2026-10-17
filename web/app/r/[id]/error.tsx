"use client";

import { MessagePage } from "@/components/message-page";

export default function RequestError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <MessagePage
      eyebrow="Payment request"
      title="This request didn't load"
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
      <p>Something went wrong on our side while reading this request. Your money hasn&apos;t moved. Try again in a moment.</p>
    </MessagePage>
  );
}
