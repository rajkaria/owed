import { AlertIcon } from "./icons";

// F1: "Requested by @handle · not verified by Owed" for a request that carries the requester's own X handle. Owed
// can't resolve X handles (PayBox resolve_username can), so the handle is shown as the requester's claim, never as
// an identity: the payer's agent checks it with resolve_username before paying (pay_link and pay_all say so).
// No data fetching and no hooks: renders on the server or the client. Nothing renders without a well-formed handle.

const HANDLE = /^[a-z0-9_]{1,15}$/;

export function HandleBadge({ handle }: { handle: string | null | undefined }) {
  if (!handle || !HANDLE.test(handle)) return null;
  return (
    <section
      aria-label={`Requested by @${handle}, not verified by Owed`}
      role="note"
      className="mt-4 rounded-xl border border-line bg-surface px-4 py-3.5 text-sm"
    >
      <p className="flex items-start gap-2.5 leading-snug">
        <AlertIcon className="mt-0.5 shrink-0 text-muted" width={18} height={18} />
        <span>
          <span className="font-semibold">
            Requested by <span className="break-all">@{handle}</span>
          </span>
          <span className="text-muted"> · not verified by Owed</span>
          <span className="mt-1 block text-muted">
            Anyone can type a handle, and Owed hasn&apos;t checked this one. An agent paying through Owed is asked to check that @{handle} resolves to the wallet this request pays.
          </span>
        </span>
      </p>
    </section>
  );
}
