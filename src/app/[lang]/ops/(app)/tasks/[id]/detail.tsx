import Link from "next/link";
import type { ReactNode } from "react";
import { TaskCard } from "@/components/ops/task-card";
import { Card } from "@/components/ops/ui";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { todayIn } from "@/domain/dates";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate } from "@/i18n/formatters";
import type { Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { taskDetail } from "@/lib/ops/task-detail";

/**
 * One task: the card with its actions (which come back here), the villa and
 * booking it belongs to, who created and finished it, and its history. Used
 * by the full page and the detail panel.
 */
export async function TaskDetail({
  lang,
  dict,
  id,
  searchParams,
  inPanel = false,
}: {
  lang: Locale;
  dict: Dictionary;
  id: string;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  inPanel?: boolean;
}) {
  const staff = await requireStaff(lang);
  const t = dict.taskDetail;
  const sp = await searchParams;
  const data = can(staff.actor, "tasks.view").allowed ? await taskDetail(staff.actor, id) : null;
  if (!data) return <ErrorNote>{t.notFound}</ErrorNote>;
  const { row, people, history } = data;
  const task = row.task;
  const now = new Date();
  const today = todayIn(row.timezone, now);
  const nowTime = new Intl.DateTimeFormat("en-GB", { timeZone: row.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const when = (d: Date) => new Intl.DateTimeFormat(lang === "id" ? "id-ID" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: row.timezone }).format(d);
  const who = (name: string | null, actorType?: string) => name ?? (actorType === "guest" ? t.guest : t.system);
  const done = typeof sp.done === "string" ? ((dict.tasks.done as Record<string, string>)[sp.done] ?? dict.tasks.done["1"]) : null;
  const error = typeof sp.error === "string" ? ((dict.tasks.errors as Record<string, string>)[sp.error] ?? dict.tasks.errors.not_found) : null;
  const checklist = row.typeContent?.inspectionChecklist?.length ? row.typeContent.inspectionChecklist : Object.values(dict.tasks.defaultChecklist);
  const actions = t.actions as Record<string, string>;

  return (
    <div className="space-y-5">
      {inPanel ? null : (
        <Link href={`/${lang}/ops/tasks`} className="text-sm text-lagoon hover:underline">
          ← {t.back}
        </Link>
      )}
      <div className="space-y-2">
        {done ? <SuccessNote>{done}</SuccessNote> : null}
        <ErrorNote>{error}</ErrorNote>
      </div>
      <TaskCard
        row={{ task, unitCode: row.unitCode, unitTypeId: row.unitTypeId, typeContent: row.typeContent, assigneeName: row.assigneeName, reservationCode: row.reservationCode }}
        lang={lang}
        dict={dict}
        today={today}
        nowTime={nowTime}
        me={staff.staffId}
        canWork={can(staff.actor, "tasks.work", task.propertyId).allowed}
        canAssign={can(staff.actor, "tasks.assign", task.propertyId).allowed}
        canCost={can(staff.actor, "owners.expense", task.propertyId).allowed}
        people={people}
        checklist={checklist}
        inDetail
      />
      <Card title={t.about}>
        <dl className="grid gap-3 text-sm @md:grid-cols-2">
          <Item label={t.property} value={row.propertyName} />
          <Item label={t.villa} value={row.unitCode ?? "—"} />
          <Item
            label={t.booking}
            value={
              row.reservationCode ? (
                <Link href={`/${lang}/ops/reservations/${row.reservationCode}`} className="font-mono text-lagoon hover:underline">
                  {row.reservationCode}
                </Link>
              ) : (
                "—"
              )
            }
          />
          <Item label={t.created} value={format(t.by, { when: when(task.createdAt), name: who(data.createdByName) })} />
          {task.completedAt ? <Item label={t.completed} value={format(t.by, { when: when(task.completedAt), name: who(data.completedByName) })} /> : null}
          {task.dueDate ? <Item label={t.due} value={`${formatDate(task.dueDate, lang)}${task.dueTime ? ` · ${task.dueTime.slice(0, 5)}` : ""}`} /> : null}
        </dl>
      </Card>
      <Card title={t.history}>
        {history.length ? (
          <ol className="space-y-2 text-sm">
            {history.map((h, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-2 border-b border-line/60 pb-2 last:border-0 last:pb-0">
                <span className="text-ink">{actions[h.action] ?? h.action}</span>
                <span className="text-xs text-stone">{format(t.by, { when: when(h.occurredAt), name: who(h.actorName, h.actorType) })}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-stone">{t.noHistory}</p>
        )}
      </Card>
    </div>
  );
}

function Item({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-stone">{label}</dt>
      <dd className="mt-0.5 text-ink">{value}</dd>
    </div>
  );
}
