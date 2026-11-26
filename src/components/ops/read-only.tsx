import type { ReactNode } from "react";

/**
 * Shows settings forms to someone who may look but not change them (a
 * director): every field is disabled and the buttons are hidden. The server
 * actions still check permission; this only keeps the page honest.
 */
export function ReadOnly({ readOnly, note, children }: { readOnly: boolean; note: string; children: ReactNode }) {
  if (!readOnly) return <>{children}</>;
  return (
    <fieldset disabled className="m-0 min-w-0 border-0 p-0 [&_button]:hidden">
      <p className="mt-4 rounded-lg border border-line bg-sand px-4 py-3 text-sm text-ink">{note}</p>
      {children}
    </fieldset>
  );
}
