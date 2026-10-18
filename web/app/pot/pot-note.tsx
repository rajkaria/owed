import Link from "next/link";
import { cleanText } from "@/lib/view/text";
import { POT_TITLE_LIMIT } from "./[id]/model";

/**
 * F7: on a contribution's pay page (/r/<id>), the pot it belongs to, with a link to its board. The title is the
 * requester's words: quoted, cleaned again here. Renders nothing for an ordinary request.
 */
export function PotNote({ pot }: { pot?: { id: string; title: string } | null }) {
  if (!pot || !/^[1-9A-HJ-NP-Za-km-z]{14}$/.test(pot.id)) return null;
  const title = cleanText(pot.title, POT_TITLE_LIMIT);
  return (
    <p className="mt-3 text-sm text-muted">
      A contribution to the chip-in pot{title ? <> <q className="text-fg"><bdi>{title}</bdi></q></> : null}.{" "}
      <Link href={`/pot/${pot.id}`} prefetch={false} className="font-medium text-accent underline-offset-4 hover:underline">
        See the pot
      </Link>
    </p>
  );
}
