"use client";

import { useState } from "react";

/** A read-only value with a copy button, for links staff send to guests. */
export function CopyField({ value, copyLabel, copiedLabel }: { value: string; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 rounded-lg border border-line bg-white px-2 py-1.5 font-mono text-xs text-ink" />
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            // Clipboard blocked: the field is still selectable by hand.
          }
        }}
        className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink hover:bg-sand"
      >
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
}
