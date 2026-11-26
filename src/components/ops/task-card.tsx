import Link from "next/link";
import type { taskBoard } from "@/domain/tasks";
import { urgency } from "@/domain/tasks";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate } from "@/i18n/formatters";
import type { Dictionary } from "@/i18n/get-dictionary";
import {
  assignTaskAction,
  cancelTaskAction,
  claimTaskAction,
  finishCleaningAction,
  finishInspectionAction,
  finishTaskAction,
  startTaskAction,
} from "@/lib/ops/task-actions";

export type TaskRow = Awaited<ReturnType<typeof taskBoard>>[number];
type Row = TaskRow;

const input = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";

/**
 * One task with the actions the staff member may take. On the board its
 * title opens the detail panel; in the detail (inDetail) the actions return
 * to the detail rather than the board.
 */
export function TaskCard({
  row,
  lang,
  dict,
  today,
  nowTime,
  me,
  canWork,
  canAssign,
  canCost,
  people,
  checklist,
  inDetail = false,
}: {
  row: Row;
  lang: Locale;
  dict: Dictionary;
  today: string;
  nowTime: string;
  me: string;
  canWork: boolean;
  canAssign: boolean;
  /** May charge a ticket's cost to the villa's owner. */
  canCost: boolean;
  people: Array<{ id: string; fullName: string }>;
  checklist: string[];
  inDetail?: boolean;
}) {
  const t = dict.tasks;
  const { task } = row;
  const active = task.status === "open" || task.status === "in_progress";
  const u = urgency(task, today, nowTime);
  const hidden = (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="taskId" value={task.id} />
      {inDetail ? <input type="hidden" name="returnTo" value="detail" /> : null}
    </>
  );
  const title = task.kind === "clean" ? t.kinds.clean : task.kind === "inspect" ? t.kinds.inspect : task.title.startsWith("Guest request") ? t.kinds.request : task.title;
  const due = task.dueDate
    ? task.dueDate === today
      ? format(t.dueToday, { time: task.dueTime?.slice(0, 5) ?? "" })
      : format(t.dueOn, { date: formatDate(task.dueDate, lang), time: task.dueTime?.slice(0, 5) ?? "" })
    : null;
  return (
    <article id={`task-${task.id}`} className={`space-y-2 rounded-xl border bg-white/80 p-4 text-sm ${u === "late" ? "border-danger/50" : u === "soon" ? "border-terracotta/60" : "border-line"}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium text-ink">
            {row.unitCode ? <span className="font-mono">{row.unitCode} · </span> : null}
            {inDetail ? (
              title
            ) : (
              <Link href={`/${lang}/ops/tasks/${task.id}`} className="hover:text-lagoon hover:underline">
                {title}
              </Link>
            )}
          </p>
          <p className="text-xs text-stone">
            <span className="rounded bg-sand px-1.5 py-0.5 text-ink">{(t.kindLabels as Record<string, string>)[task.kind]}</span>
            {task.status === "in_progress" ? ` · ${t.inProgress}` : ""}
            {row.reservationCode ? (
              <>
                {" · "}
                <Link href={`/${lang}/ops/reservations/${row.reservationCode}`} className="font-mono text-lagoon hover:underline">
                  {row.reservationCode}
                </Link>
              </>
            ) : null}
            {task.blockId ? ` · ${t.villaBlocked}` : ""}
          </p>
        </div>
        <div className="text-right text-xs">
          {due ? <p className={u === "late" ? "font-medium text-danger" : u === "soon" ? "font-medium text-terracotta-deep" : "text-stone"}>{u === "late" ? `${t.late} · ${due}` : due}</p> : null}
          <p className="text-stone">{row.assigneeName ? format(t.assignedTo, { name: row.assigneeName }) : t.nobody}</p>
        </div>
      </header>
      {task.notes ? <p className="whitespace-pre-line rounded-lg bg-sand/60 px-3 py-2 text-ink">{task.notes}</p> : null}
      {task.result ? (
        <p className={task.result === "passed" ? "text-xs text-lagoon" : "text-xs text-danger"}>
          {task.result === "passed" ? t.passed : format(t.failed, { items: (task.checklist ?? []).filter((c) => !c.ok).map((c) => c.item).join(", ") || "—" })}
        </p>
      ) : null}

      {active && canWork ? (
        <div className="flex flex-wrap gap-2">
          {!task.assigneeId ? (
            <form action={claimTaskAction}>
              {hidden}
              <button type="submit" className="rounded-lg border border-lagoon px-3 py-1.5 text-xs font-medium text-lagoon hover:bg-lagoon-soft">
                {t.claim}
              </button>
            </form>
          ) : null}
          {task.status === "open" && (task.assigneeId === me || !task.assigneeId) ? (
            <form action={startTaskAction}>
              {hidden}
              <button type="submit" className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink hover:bg-sand">
                {t.start}
              </button>
            </form>
          ) : null}
          {canAssign ? (
            <form action={assignTaskAction} className="flex gap-1">
              {hidden}
              <select name="assigneeId" defaultValue={task.assigneeId ?? ""} className="rounded-lg border border-line bg-white px-2 py-1.5 text-xs text-ink">
                <option value="">{t.nobody}</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fullName}
                  </option>
                ))}
              </select>
              <button type="submit" className="rounded-lg border border-line px-2 py-1.5 text-xs text-ink hover:bg-sand">
                {t.assign}
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {active && canWork && task.kind === "clean" ? (
        <form action={finishCleaningAction} className="flex gap-2">
          {hidden}
          <input name="note" maxLength={500} placeholder={t.noteOptional} className={`${input} py-1.5 text-xs`} />
          <button type="submit" className="shrink-0 rounded-lg bg-lagoon px-3 py-1.5 text-xs font-medium text-ivory hover:bg-lagoon-deep">
            {t.finishCleaning}
          </button>
        </form>
      ) : null}

      {active && canWork && task.kind === "inspect" ? (
        <form action={finishInspectionAction} className="space-y-2 rounded-lg border border-line p-3">
          {hidden}
          <p className="text-xs font-medium text-ink">{t.checklist}</p>
          <ul className="space-y-1">
            {checklist.map((item) => (
              <li key={item}>
                <label className="flex items-start gap-2 text-sm text-ink">
                  <input type="checkbox" name="ticked" value={item} className="mt-0.5 h-5 w-5 accent-lagoon" />
                  <span>{item}</span>
                </label>
              </li>
            ))}
          </ul>
          <input name="note" maxLength={500} placeholder={t.inspectionNote} className={`${input} py-1.5 text-xs`} />
          <div className="flex flex-wrap gap-2">
            <button type="submit" name="result" value="passed" className="rounded-lg bg-lagoon px-3 py-1.5 text-xs font-medium text-ivory hover:bg-lagoon-deep">
              {t.pass}
            </button>
            <button type="submit" name="result" value="failed" className="rounded-lg border border-danger/40 px-3 py-1.5 text-xs text-danger hover:bg-danger/5">
              {t.fail}
            </button>
          </div>
        </form>
      ) : null}

      {active && canWork && (task.kind === "maintenance" || task.kind === "request") ? (
        <div className="flex flex-wrap gap-2">
          <form action={finishTaskAction} className="flex flex-1 gap-2">
            {hidden}
            <input name="note" maxLength={500} placeholder={t.noteOptional} className={`${input} py-1.5 text-xs`} />
            {task.kind === "maintenance" && canCost && task.unitId ? (
              <input name="cost" inputMode="numeric" maxLength={14} placeholder={t.costOptional} aria-label={t.costOptional} className={`${input} w-36 shrink-0 py-1.5 text-xs`} />
            ) : null}
            <button type="submit" className="shrink-0 rounded-lg bg-lagoon px-3 py-1.5 text-xs font-medium text-ivory hover:bg-lagoon-deep">
              {task.kind === "maintenance" ? t.finishMaintenance : t.finishRequest}
            </button>
          </form>
          {canAssign ? (
            <form action={cancelTaskAction}>
              {hidden}
              <button type="submit" className="rounded-lg border border-line px-3 py-1.5 text-xs text-stone hover:bg-sand">
                {t.cancel}
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
