"use client";

import Form from "next/form";
import type { ReactNode } from "react";

/**
 * A row of table filters that lives in the address (shareable, survives a
 * reload). Choosing an option applies it at once; text fields apply on Enter.
 * Navigation stays client-side (next/form), so the menu and panel keep their state.
 */
export function FilterForm({ action, children, className = "" }: { action: string; children: ReactNode; className?: string }) {
  return (
    <Form
      action={action}
      className={className}
      onChange={(e) => {
        const target = e.target as HTMLElement;
        const applyNow = target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && ["checkbox", "radio", "date"].includes(target.type));
        if (applyNow) e.currentTarget.requestSubmit();
      }}
    >
      {children}
    </Form>
  );
}
