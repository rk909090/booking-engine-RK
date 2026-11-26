import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { addDays } from "@/domain/dates";
import { TASK_KINDS } from "@/domain/tasks";
import type { Actor } from "@/lib/authz/permissions";

/*
 * The task table: any task (not only the open ones and the last day's
 * finished ones the board used to show), filtered and paged. Active tasks
 * come soonest-due first; finished ones most recent first.
 */

export const TASK_STATUS_FILTERS = ["active", "open", "in_progress", "done", "cancelled", "all"] as const;
export const TASK_DUE_FILTERS = ["late", "today", "week", "none"] as const;
const PAGE = 50;

export type TaskFilters = {
  status?: string;
  kind?: string;
  /** "me", "none" or a staff id. */
  assignee?: string;
  property?: string;
  due?: string;
  q?: string;
  page?: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listTasks(actor: Actor, input: { propertyIds: string[]; filters: TaskFilters; today: string; nowTime: string }) {
  const { filters, today, nowTime } = input;
  const t = schema.tasks;
  const status = (TASK_STATUS_FILTERS as readonly string[]).includes(filters.status ?? "") ? filters.status! : "active";
  const kind = (TASK_KINDS as readonly string[]).includes(filters.kind ?? "") ? filters.kind! : "";
  const due = (TASK_DUE_FILTERS as readonly string[]).includes(filters.due ?? "") ? filters.due! : "";
  const q = filters.q?.trim().slice(0, 80) ?? "";
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  if (!input.propertyIds.length) return { rows: [], total: 0, page, pages: 1, applied: { status, kind, due, q, assignee: "" } };

  const assignee = filters.assignee === "me" ? actor.staffId : filters.assignee === "none" ? "none" : filters.assignee && UUID.test(filters.assignee) ? filters.assignee : "";
  const late = or(lt(t.dueDate, today), and(eq(t.dueDate, today), sql`${t.dueTime} < ${nowTime}::time`));
  const conditions: Array<SQL | undefined> = [
    inArray(t.propertyId, input.propertyIds),
    status === "active" ? inArray(t.status, ["open", "in_progress"]) : status === "all" ? undefined : eq(t.status, status),
    kind ? eq(t.kind, kind) : undefined,
    assignee === "none" ? isNull(t.assigneeId) : assignee ? eq(t.assigneeId, assignee) : undefined,
    due === "late" ? and(inArray(t.status, ["open", "in_progress"]), late) : undefined,
    due === "today" ? eq(t.dueDate, today) : undefined,
    due === "week" ? and(gte(t.dueDate, today), lte(t.dueDate, addDays(today, 6))) : undefined,
    due === "none" ? isNull(t.dueDate) : undefined,
    q
      ? or(ilike(t.title, `%${q}%`), ilike(t.notes, `%${q}%`), ilike(schema.units.code, `%${q}%`), ilike(schema.reservations.code, `%${q}%`), ilike(schema.staffMembers.fullName, `%${q}%`))
      : undefined,
  ];
  const where = and(...conditions);
  const db = getDb();
  const base = db
    .select({
      task: t,
      unitCode: schema.units.code,
      unitTypeId: schema.units.unitTypeId,
      typeContent: schema.unitTypes.content,
      assigneeName: schema.staffMembers.fullName,
      reservationCode: schema.reservations.code,
      propertyName: schema.properties.name,
    })
    .from(t)
    .innerJoin(schema.properties, eq(schema.properties.id, t.propertyId))
    .leftJoin(schema.units, eq(schema.units.id, t.unitId))
    .leftJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.units.unitTypeId))
    .leftJoin(schema.staffMembers, eq(schema.staffMembers.id, t.assigneeId))
    .leftJoin(schema.reservations, eq(schema.reservations.id, t.reservationId))
    .where(where);
  const finished = status === "done" || status === "cancelled";
  const [rows, [{ total }]] = await Promise.all([
    (finished ? base.orderBy(desc(t.completedAt)) : base.orderBy(sql`${t.dueDate} ASC NULLS LAST`, sql`${t.dueTime} ASC NULLS LAST`, asc(t.createdAt)))
      .limit(PAGE)
      .offset((page - 1) * PAGE),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(t)
      .leftJoin(schema.units, eq(schema.units.id, t.unitId))
      .leftJoin(schema.staffMembers, eq(schema.staffMembers.id, t.assigneeId))
      .leftJoin(schema.reservations, eq(schema.reservations.id, t.reservationId))
      .where(where),
  ]);
  return { rows, total, page, pages: Math.max(1, Math.ceil(total / PAGE)), applied: { status, kind, due, q, assignee: filters.assignee ?? "" } };
}

/** Counts for the quick filters above the table. */
export async function taskCounts(actor: Actor, input: { propertyIds: string[]; today: string; nowTime: string }) {
  if (!input.propertyIds.length) return { active: 0, mine: 0, unassigned: 0, late: 0 };
  const t = schema.tasks;
  const active = sql`${t.status} IN ('open', 'in_progress')`;
  const [row] = await getDb()
    .select({
      active: sql<number>`count(*) FILTER (WHERE ${active})::int`,
      mine: sql<number>`count(*) FILTER (WHERE ${active} AND ${t.assigneeId} = ${actor.staffId})::int`,
      unassigned: sql<number>`count(*) FILTER (WHERE ${active} AND ${t.assigneeId} IS NULL)::int`,
      late: sql<number>`count(*) FILTER (WHERE ${active} AND (${t.dueDate} < ${input.today} OR (${t.dueDate} = ${input.today} AND ${t.dueTime} < ${input.nowTime}::time)))::int`,
    })
    .from(t)
    .where(inArray(t.propertyId, input.propertyIds));
  return row;
}
