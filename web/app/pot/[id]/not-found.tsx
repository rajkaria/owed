import { MessagePage } from "@/components/message-page";

export default function PotNotFound() {
  return (
    <MessagePage eyebrow="Chip-in pot" title="We can't find this pot">
      <p>
        The link may be mistyped or cut off. Ask the person who sent it to share it again. Don&apos;t send money to an address
        you can&apos;t check.
      </p>
    </MessagePage>
  );
}
