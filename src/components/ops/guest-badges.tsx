import type { Dictionary } from "@/i18n/get-dictionary";
import { format } from "@/i18n/format";

/** Small badges for a guest: returning (with how many past stays) and the profile's tags. */
export function GuestBadges({ dict, tags, pastStays }: { dict: Dictionary; tags: readonly string[]; pastStays: number }) {
  const t = dict.guests;
  const labels = t.tags as Record<string, string>;
  if (!pastStays && !tags.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {pastStays > 0 ? (
        <span className="rounded-full bg-lagoon-soft px-2 py-0.5 text-xs font-medium text-lagoon">{format(t.returning, { count: pastStays })}</span>
      ) : null}
      {tags.map((tag) => (
        <span key={tag} className={`rounded-full px-2 py-0.5 text-xs font-medium ${tag === "caution" ? "bg-danger/10 text-danger" : tag === "vip" ? "bg-terracotta/15 text-terracotta-deep" : "bg-sand text-ink"}`}>
          {labels[tag] ?? tag}
        </span>
      ))}
    </span>
  );
}
