"use client";

import { useActionState } from "react";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import type { Dictionary } from "@/i18n/get-dictionary";
import { revealDocumentsAction, type RevealState } from "@/lib/ops/precheckin-actions";

type Guest = {
  position: number;
  fullName: string;
  nationalityName: string;
  birthDate: string;
  age: number;
  documentType: string | null;
  documentLast4: string | null;
  hasDocument: boolean;
  documentErased: boolean;
};

/** The guests of a pre-check-in, with document numbers masked until a front-desk user reveals them. */
export function PreCheckinGuests({ lang, code, guests, canReveal, t }: { lang: Locale; code: string; guests: Guest[]; canReveal: boolean; t: Dictionary["preCheckinStaff"] }) {
  const [state, action, pending] = useActionState<RevealState, FormData>(revealDocumentsAction, {});
  const full = (position: number) => state.numbers?.find((n) => n.position === position)?.documentNumber;
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-line/60 text-sm">
        {guests.map((g) => {
          const number = full(g.position);
          return (
            <li key={g.position} className="py-2">
              <p className="font-medium text-ink">{g.fullName}</p>
              <p className="text-xs text-stone">
                {g.nationalityName} · {format(t.age, { age: g.age, date: g.birthDate })}
              </p>
              <p className="text-xs text-ink">
                {g.documentType === "id_card" ? t.idCard : t.passport}:{" "}
                {g.documentErased ? (
                  <span className="text-stone">{t.erased}</span>
                ) : number ? (
                  <span className="font-mono">{number}</span>
                ) : number === null && state.numbers ? (
                  <span className="text-danger">{t.unreadable}</span>
                ) : (
                  <span className="font-mono">•••• {g.documentLast4 ?? ""}</span>
                )}
              </p>
            </li>
          );
        })}
      </ul>
      {canReveal && guests.some((g) => g.hasDocument) && !state.numbers ? (
        <form action={action}>
          <input type="hidden" name="lang" value={lang} />
          <input type="hidden" name="code" value={code} />
          <button type="submit" disabled={pending} className="w-full rounded-lg border border-line px-3 py-2 text-sm text-ink hover:bg-sand disabled:opacity-60">
            {pending ? t.revealing : t.reveal}
          </button>
          <p className="mt-1 text-xs text-stone">{t.revealHint}</p>
        </form>
      ) : null}
      {state.error ? <p className="text-xs text-danger">{state.error === "role" ? t.roleNotAllowed : t.unreadable}</p> : null}
    </div>
  );
}
