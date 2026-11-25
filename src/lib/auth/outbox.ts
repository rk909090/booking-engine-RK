/**
 * Where password-setup links go. There is no email service yet, so links are
 * only handed to an in-process collector (the staff:invite script installs
 * one). Running servers never log the link itself: it is a credential.
 */
export type OutgoingLink = { email: string; url: string };

type Collector = (link: OutgoingLink) => void;

let collector: Collector | undefined;

export function setLinkCollector(next: Collector | undefined) {
  collector = next;
}

export function deliverSetupLink(link: OutgoingLink) {
  if (collector) {
    collector(link);
    return;
  }
  console.warn(
    `[auth] Email delivery is not configured; password link for ${link.email} was not sent. ` +
      "Re-issue it with `npm run staff:invite`.",
  );
}
