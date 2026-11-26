"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { dragModes, dragTarget, overlapsOnTarget, type DragMode, type DragTarget } from "@/domain/calendar-drag";
import { diffDays } from "@/domain/dates";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatDateRange, formatMoney } from "@/i18n/formatters";
import type { Dictionary } from "@/i18n/get-dictionary";
import { applyCalendarMove, previewCalendarMove, type CalendarPreview } from "@/lib/ops/calendar-actions";

type Stay = { code: string; unitId: string; status: string; checkIn: string; checkOut: string; guestName: string };
type Unit = { id: string; code: string; name: string; unitTypeId: string };
type Block = { id: string; unitId: string; startDate: string; endDate: string; reason: string; kind: "maintenance" | "channel" };
type Move = { code: string; checkIn: string; checkOut: string; unitId: string };

type Props = {
  lang: Locale;
  dict: { cal: Dictionary["opsCalendar"]; sc: Dictionary["stayChange"]; status: Dictionary["booking"]["status"] };
  from: string;
  days: string[];
  today: string;
  units: Unit[];
  stays: Stay[];
  blocks: Block[];
  canModify: boolean;
  canMove: boolean;
};

const barTone: Record<string, string> = {
  hold: "bg-sand text-terracotta-deep border-terracotta/40 border-dashed",
  confirmed: "bg-lagoon-soft text-lagoon border-lagoon/30",
  in_house: "bg-lagoon text-ivory border-lagoon",
  checked_out: "bg-line text-stone border-line",
};

type Drag = { mode: DragMode; stay: Stay; grabDate: string; startX: number; startY: number; moved: boolean; target: DragTarget | null };
type Panel = { move: Move; stay: Stay; preview: CalendarPreview | null; busy: "checking" | "saving" | null; error: string | null };

/** The day cell under a screen point (bars sit on top of the cells, so look through them). */
function cellAt(x: number, y: number): { unitId: string; date: string } | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el instanceof HTMLElement && el.dataset.cell) return { unitId: el.dataset.unit!, date: el.dataset.date! };
  }
  return null;
}

/**
 * The tape chart. Staff who may change bookings drag a bar to other dates or
 * another villa of the same type, or drag its right edge to change the
 * check-out date. Nothing is saved on drop: the server previews the change
 * (price, balance, conflicts) and staff confirm it.
 */
export function TapeChartBoard({ lang, dict, from, days, today, units, stays, blocks, canModify, canMove, cellWidth = 44 }: Props & { cellWidth?: number }) {
  const { cal: t, sc } = dict;
  const router = useRouter();
  const span = days.length;
  const [drag, setDrag] = useState<Drag | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const unitCode = (id: string) => units.find((u) => u.id === id)?.code ?? "";

  const preview = useCallback(
    async (move: Move, stay: Stay, error: string | null = null) => {
      setPanel({ move, stay, preview: null, busy: "checking", error });
      try {
        const result = await previewCalendarMove({ lang, ...move });
        setPanel((p) => (p && p.move === move ? { ...p, preview: result, busy: null } : p));
      } catch {
        setPanel((p) => (p && p.move === move ? { ...p, busy: null, error: t.failed } : p));
      }
    },
    [lang, t.failed],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
      const cell = cellAt(e.clientX, e.clientY);
      const target = cell ? dragTarget({ mode: d.mode, stay: d.stay, grabDate: d.grabDate, hover: cell, units, canMove }) : d.target;
      dragRef.current = { ...d, moved: true, target };
      setDrag(dragRef.current);
    },
    [units, canMove],
  );

  const finish = useCallback(
    (cancelled: boolean) => {
      const d = dragRef.current;
      if (!d) return;
      window.removeEventListener("pointermove", onPointerMove);
      dragRef.current = null;
      setDrag(null);
      if (!d?.moved) return;
      // The click that follows this pointerup must not open the booking.
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      const target = d.target;
      if (cancelled || !target || target.issue === "no_change") return;
      if (target.issue) {
        setNotice({ text: t.issues[target.issue], tone: "warn" });
        return;
      }
      setNotice(null);
      void preview({ code: d.stay.code, checkIn: target.checkIn, checkOut: target.checkOut, unitId: target.unitId }, d.stay);
    },
    [onPointerMove, preview, t.issues],
  );

  useEffect(() => {
    const up = () => finish(false);
    const cancel = () => finish(true);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (dragRef.current) finish(true);
      else setPanel((p) => (p?.busy === "saving" ? p : null));
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, [finish, onPointerMove]);

  const start = (e: ReactPointerEvent, stay: Stay, mode: DragMode) => {
    if (e.button !== 0 || panel?.busy === "saving") return;
    const cell = cellAt(e.clientX, e.clientY);
    if (!cell) return;
    e.stopPropagation();
    dragRef.current = { mode, stay, grabDate: cell.date, startX: e.clientX, startY: e.clientY, moved: false, target: null };
    window.addEventListener("pointermove", onPointerMove);
  };

  const confirm = async () => {
    if (!panel?.preview?.ok) return;
    const { move, stay } = panel;
    const expectedTotal = panel.preview.plan.total;
    setPanel({ ...panel, busy: "saving", error: null });
    try {
      const result = await applyCalendarMove({ lang, ...move, expectedTotal });
      if (result.ok) {
        setPanel(null);
        setNotice({ text: t.saved, tone: "ok" });
        router.refresh();
      } else if (result.error === "price_changed") {
        await preview(move, stay, sc.errors.price_changed);
      } else {
        setPanel((p) => (p ? { ...p, busy: null, error: errorText(result.error) } : p));
      }
    } catch {
      setPanel((p) => (p ? { ...p, busy: null, error: t.failed } : p));
    }
  };

  const errorText = (code: string, extra: { minNights?: number; maxNights?: number } = {}) =>
    code === "role"
      ? t.roleNotAllowed
      : format((sc.errors as Record<string, string>)[code] ?? sc.errors.not_found, { min: extra.minNights ?? "", max: extra.maxNights ?? "" });

  // The bar a drag or an open preview would produce.
  const ghost = (() => {
    const source = drag?.moved && drag.target ? { ...drag.target, stay: drag.stay, live: true } : panel ? { ...panel.move, issue: null, stay: panel.stay, live: false } : null;
    if (!source) return null;
    const row = units.findIndex((u) => u.id === source.unitId);
    const startCol = Math.max(0, diffDays(from, source.checkIn));
    const endCol = Math.min(span, diffDays(from, source.checkOut));
    if (row < 0 || endCol <= startCol) return null;
    const ok =
      !source.issue &&
      !overlapsOnTarget(source, source.stay.code, stays, blocks) &&
      (source.stay.status !== "confirmed" || source.checkIn >= today);
    return { row, startCol, endCol, ok, source };
  })();

  // Narrower day columns for long ranges, so 90 days still fit a wide screen.
  const columns = `minmax(140px, 180px) repeat(${span}, minmax(${cellWidth}px, 1fr))`;
  const narrow = cellWidth < 32;

  return (
    <>
      {canModify ? <p className="mt-1 text-xs text-stone">{t.dragHint}</p> : null}
      {notice ? (
        <p role="status" className={`mt-3 rounded-lg border px-3 py-2 text-sm ${notice.tone === "ok" ? "border-lagoon/30 bg-lagoon-soft text-lagoon" : "border-terracotta/40 bg-sand text-ink"}`}>
          {notice.text}
        </p>
      ) : null}

      <div className={`mt-5 overflow-x-auto rounded-xl border border-line bg-white/70 ${drag?.moved ? "cursor-grabbing select-none" : ""}`}>
        <div className="grid text-xs" style={{ gridTemplateColumns: columns, minWidth: 180 + span * cellWidth }}>
          <div className="sticky left-0 z-10 border-b border-r border-line bg-white px-3 py-2 font-medium text-stone">{t.unit}</div>
          {days.map((d) => (
            <div key={d} title={formatDate(d, lang, { weekday: "long", day: "numeric", month: "long" })} className={`border-b border-line px-0.5 py-2 text-center ${d === today ? "bg-terracotta/10 font-semibold text-terracotta-deep" : "text-stone"} ${d.endsWith("-01") ? "border-l border-l-lagoon/30" : ""}`}>
              {narrow ? formatDate(d, lang, { weekday: "narrow" }) : formatDate(d, lang, { weekday: "short" })}
              <span className={`block text-ink ${narrow ? "text-xs" : "text-sm"}`}>{Number(d.slice(8))}</span>
            </div>
          ))}

          {units.map((u, row) => {
            const gridRow = row + 2;
            return [
              <div key={`${u.id}-label`} className="sticky left-0 z-10 border-b border-r border-line bg-white px-3 py-2" style={{ gridRow, gridColumn: 1 }}>
                <span className="block text-sm text-ink">{u.name}</span>
                <span className="font-mono text-[11px] text-stone">{u.code}</span>
              </div>,
              ...days.map((d, i) => (
                <div
                  key={`${u.id}-${d}`}
                  data-cell="1"
                  data-unit={u.id}
                  data-date={d}
                  className={`border-b border-line/60 ${d === today ? "bg-terracotta/5" : ""}`}
                  style={{ gridRow, gridColumn: i + 2 }}
                />
              )),
              ...blocks
                .filter((b) => b.unitId === u.id)
                .map((b) => {
                  const startCol = Math.max(0, diffDays(from, b.startDate));
                  const endCol = Math.min(span, diffDays(from, b.endDate));
                  if (endCol <= startCol) return null;
                  if (b.kind === "channel") {
                    return (
                      <div
                        key={b.id}
                        title={`${t.channel}: ${b.reason}`}
                        className="pointer-events-none z-0 mx-0.5 my-1.5 truncate rounded-md border border-stone/40 bg-[repeating-linear-gradient(135deg,#ece8df,#ece8df_6px,#f5f2ec_6px,#f5f2ec_12px)] px-2 py-1 text-[11px] leading-tight text-ink"
                        style={{ gridRow, gridColumn: `${startCol + 2} / ${endCol + 2}` }}
                      >
                        <span className="font-medium">{b.reason}</span>
                        <span className="block opacity-70">{t.channel}</span>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={b.id}
                      title={`${t.block}: ${b.reason}`}
                      className="pointer-events-none z-0 mx-0.5 my-1.5 truncate rounded-md border border-danger/30 bg-[repeating-linear-gradient(45deg,#f6e3e1,#f6e3e1_6px,#fbf1ef_6px,#fbf1ef_12px)] px-2 py-1 text-[11px] leading-tight text-danger"
                      style={{ gridRow, gridColumn: `${startCol + 2} / ${endCol + 2}` }}
                    >
                      <span className="font-medium">{t.block}</span>
                      <span className="block opacity-80">{b.reason}</span>
                    </div>
                  );
                }),
              ...stays
                .filter((s) => s.unitId === u.id)
                .map((s) => {
                  const startCol = Math.max(0, diffDays(from, s.checkIn));
                  const endCol = Math.min(span, diffDays(from, s.checkOut));
                  if (endCol <= startCol) return null;
                  const modes = dragModes(s.status, canModify);
                  const dragging = drag?.moved && drag.stay.code === s.code;
                  return (
                    <Link
                      key={s.code}
                      href={`/${lang}/ops/reservations/${s.code}`}
                      draggable={false}
                      onDragStart={(e) => e.preventDefault()}
                      onClick={(e) => {
                        if (suppressClick.current) e.preventDefault();
                      }}
                      onPointerDown={modes.includes("move") ? (e) => start(e, s, "move") : undefined}
                      title={`${s.guestName} · ${s.code} · ${dict.status[s.status as keyof typeof dict.status] ?? s.status}`}
                      className={`relative z-0 mx-0.5 my-1.5 truncate rounded-md border px-2 py-1 text-[11px] leading-tight hover:brightness-95 ${barTone[s.status] ?? barTone.confirmed} ${
                        modes.includes("move") ? "cursor-grab touch-none select-none" : ""
                      } ${dragging ? "opacity-40" : ""}`}
                      style={{ gridRow, gridColumn: `${startCol + 2} / ${endCol + 2}` }}
                    >
                      <span className="font-medium">{s.guestName}</span>
                      <span className="block opacity-80">{dict.status[s.status as keyof typeof dict.status] ?? s.status}</span>
                      {modes.includes("resize") && diffDays(from, s.checkOut) <= span ? (
                        <span
                          role="presentation"
                          title={t.resizeHandle}
                          onPointerDown={(e) => start(e, s, "resize")}
                          className="absolute inset-y-0 right-0 w-2.5 cursor-ew-resize touch-none rounded-r-md bg-current/20 hover:bg-current/40"
                        />
                      ) : null}
                    </Link>
                  );
                }),
            ];
          })}

          {ghost ? (
            <div
              aria-hidden
              className={`pointer-events-none z-20 mx-0.5 my-1 truncate rounded-md border-2 border-dashed px-2 py-1 text-[11px] font-medium leading-tight ${
                ghost.ok ? "border-lagoon bg-lagoon-soft text-lagoon shadow-md" : "border-danger bg-[#fbf1ef] text-danger shadow-md"
              }`}
              style={{ gridRow: ghost.row + 2, gridColumn: `${ghost.startCol + 2} / ${ghost.endCol + 2}` }}
            >
              {formatDateRange(ghost.source.checkIn, ghost.source.checkOut, lang)}
              <span className="block opacity-80">{format(sc.nights, { count: diffDays(ghost.source.checkIn, ghost.source.checkOut) })}</span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-stone" aria-label={t.legend}>
        {(["hold", "confirmed", "in_house", "checked_out"] as const).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={`inline-block h-3 w-5 rounded border ${barTone[s]}`} /> {dict.status[s]}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-5 rounded border border-danger/30 bg-[repeating-linear-gradient(45deg,#f6e3e1,#f6e3e1_3px,#fbf1ef_3px,#fbf1ef_6px)]" /> {t.block}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-5 rounded border border-stone/40 bg-[repeating-linear-gradient(135deg,#ece8df,#ece8df_3px,#f5f2ec_3px,#f5f2ec_6px)]" /> {t.channel}
        </span>
      </div>

      {panel ? (
        <section
          role="dialog"
          aria-labelledby="move-preview-title"
          className="fixed inset-x-4 bottom-4 z-50 max-h-[80vh] overflow-y-auto rounded-xl border border-line bg-white p-4 shadow-xl sm:inset-x-auto sm:right-4 sm:w-[420px]"
        >
          <h2 id="move-preview-title" className="font-display text-lg text-lagoon">
            {sc.previewTitle}
          </h2>
          <p className="text-sm text-ink">
            {panel.stay.guestName} ·{" "}
            <Link href={`/${lang}/ops/reservations/${panel.stay.code}`} className="font-mono text-lagoon hover:underline">
              {panel.stay.code}
            </Link>
          </p>

          {panel.error ? <p className="mt-3 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">{panel.error}</p> : null}
          {panel.busy === "checking" ? <p className="mt-3 text-sm text-stone">{t.checking}</p> : null}

          {panel.preview && !panel.preview.ok ? (
            <div className="mt-3 space-y-2 text-sm">
              <p className="rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-danger">
                {errorText(panel.preview.error, "minNights" in panel.preview ? panel.preview : {})}
              </p>
              {"codes" in panel.preview && panel.preview.codes?.length ? (
                <p className="text-xs text-ink">
                  {sc.conflictWith}{" "}
                  {panel.preview.codes.map((c, i) => (
                    <span key={c}>
                      {i > 0 ? ", " : ""}
                      <Link href={`/${lang}/ops/reservations/${c}`} className="font-mono text-lagoon hover:underline">
                        {c}
                      </Link>
                    </span>
                  ))}
                </p>
              ) : null}
              {canMove && "alternatives" in panel.preview && panel.preview.alternatives?.length ? (
                <div className="text-xs text-ink">
                  <p>{sc.alternatives}</p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {panel.preview.alternatives.map((alt) => (
                      <button
                        key={alt.id}
                        type="button"
                        onClick={() => void preview({ ...panel.move, unitId: alt.id }, panel.stay)}
                        className="rounded-lg border border-line px-2 py-1 font-mono text-lagoon hover:bg-sand"
                      >
                        {format(sc.useUnit, { code: alt.code })}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {panel.preview?.ok ? (
            <div className="mt-3 space-y-2">
              <dl className="space-y-1 text-sm">
                {panel.preview.before ? (
                  <Row label={sc.before} value={`${formatDateRange(panel.preview.before.checkIn, panel.preview.before.checkOut, lang)} · ${unitCode(panel.preview.before.unitId)}`} />
                ) : null}
                <Row
                  label={sc.after}
                  value={`${formatDateRange(panel.preview.plan.checkIn, panel.preview.plan.checkOut, lang)} · ${panel.preview.plan.unitCode} · ${format(sc.nights, {
                    count: diffDays(panel.preview.plan.checkIn, panel.preview.plan.checkOut),
                  })}`}
                  strong
                />
                <Row label={sc.oldTotal} value={formatMoney(panel.preview.plan.previousTotal, lang)} />
                <Row label={sc.newTotal} value={formatMoney(panel.preview.plan.total, lang)} strong />
                <Row
                  label={sc.difference}
                  value={`${panel.preview.plan.difference > 0 ? "+" : panel.preview.plan.difference < 0 ? "−" : ""}${formatMoney(Math.abs(panel.preview.plan.difference), lang)}`}
                />
                <Row
                  label={
                    panel.preview.plan.balanceDueDate
                      ? `${sc.balanceAfter} (${format(sc.balanceDue, { date: formatDate(panel.preview.plan.balanceDueDate, lang) })})`
                      : sc.balanceAfter
                  }
                  value={formatMoney(Math.max(0, panel.preview.plan.balanceAfter), lang)}
                  strong={panel.preview.plan.balanceAfter > 0}
                />
                {panel.preview.plan.refundOutstandingAfter > 0 ? (
                  <Row label={sc.refundAfter} value={formatMoney(panel.preview.plan.refundOutstandingAfter, lang)} strong danger />
                ) : null}
              </dl>
              <p className="text-xs text-stone">{sc.keptPrice}</p>
              {panel.preview.plan.lateCheckoutCancelled ? <p className="text-xs text-danger">{sc.lateCheckoutCancelled}</p> : null}
              {panel.preview.plan.earlyCheckinCancelled ? <p className="text-xs text-danger">{sc.earlyCheckinCancelled}</p> : null}
              <p className="text-xs text-stone">{sc.guestNotice}</p>
            </div>
          ) : null}

          <div className="mt-4 flex gap-2">
            {panel.preview?.ok ? (
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={panel.busy !== null}
                className="flex-1 rounded-lg bg-lagoon px-3 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep disabled:cursor-not-allowed disabled:opacity-60"
              >
                {panel.busy === "saving" ? t.saving : sc.confirm}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setPanel(null)}
              disabled={panel.busy === "saving"}
              className="rounded-lg border border-line px-3 py-2 text-sm text-ink hover:bg-sand disabled:opacity-60"
            >
              {sc.discard}
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}

function Row({ label, value, strong, danger }: { label: string; value: string; strong?: boolean; danger?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? "font-medium" : ""} ${danger ? "text-danger" : strong ? "text-ink" : "text-stone"}`}>
      <dt>{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
