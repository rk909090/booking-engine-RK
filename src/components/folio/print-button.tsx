"use client";

/** Opens the browser's print dialog (print or save as PDF). */
export function PrintButton({ label }: { label: string }) {
  return (
    <button type="button" onClick={() => window.print()} className="rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep">
      {label}
    </button>
  );
}
