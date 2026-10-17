import { MessagePage } from "@/components/message-page";

export default function NotFound() {
  return (
    <MessagePage eyebrow="404" title="This page doesn't exist">
      <p>If someone sent you a payment link, check that you copied all of it.</p>
    </MessagePage>
  );
}
