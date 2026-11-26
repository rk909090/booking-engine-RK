import type { PGlite } from "@electric-sql/pglite";
import type postgres from "postgres";

/*
 * Copies rows between the real database and an in-memory PGlite copy.
 * The demo is built by running the real domain code against PGlite (fast,
 * same migrations), then only the new or changed rows are written to the
 * real database, in foreign-key order, in one transaction.
 */

type Row = Record<string, unknown>;
export type Snapshot = Map<string, Map<string, string>>;

export type Catalog = {
  /** Tables in foreign-key order (parents first). */
  order: string[];
  columns: Map<string, string[]>;
  keys: Map<string, string[]>;
};

/** Better Auth tables hold password hashes and 2FA secrets: never copied. */
const SKIP = (table: string) => table.startsWith("auth_");

export async function readCatalog(local: PGlite): Promise<Catalog> {
  const tables = (await local.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t);
  const columns = new Map<string, string[]>();
  for (const r of (await local.query<{ t: string; c: string }>(`SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND is_generated = 'NEVER' ORDER BY table_name, ordinal_position`)).rows) {
    columns.set(r.t, [...(columns.get(r.t) ?? []), r.c]);
  }
  const keys = new Map<string, string[]>();
  for (const r of (
    await local.query<{ t: string; c: string }>(
      `SELECT tc.table_name AS t, kcu.column_name AS c FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' ORDER BY tc.table_name, kcu.ordinal_position`,
    )
  ).rows) {
    keys.set(r.t, [...(keys.get(r.t) ?? []), r.c]);
  }
  const edges = (
    await local.query<{ child: string; parent: string }>(
      `SELECT c.relname AS child, p.relname AS parent FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
       WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace AND c.relname <> p.relname`,
    )
  ).rows;
  const order: string[] = [];
  const pending = new Set(tables);
  while (pending.size) {
    const ready = [...pending].filter((t) => !edges.some((e) => e.child === t && pending.has(e.parent)));
    if (!ready.length) throw new Error(`Foreign-key cycle between: ${[...pending].join(", ")}`);
    for (const t of ready) {
      order.push(t);
      pending.delete(t);
    }
  }
  for (const t of tables) if (!keys.has(t)) throw new Error(`Table ${t} has no primary key`);
  return { order, columns, keys };
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const keyOf = (row: Row, key: string[]) => key.map((k) => String(row[k])).join("|");

async function remoteRows(remote: postgres.Sql, table: string): Promise<Row[]> {
  const [r] = await remote.unsafe(`SELECT coalesce(json_agg(x), '[]'::json) AS rows FROM ${q(table)} x`);
  return r.rows as Row[];
}

async function localRows(local: PGlite, table: string): Promise<Row[]> {
  const r = await local.query<{ rows: Row[] | string }>(`SELECT coalesce(json_agg(x), '[]'::json) AS rows FROM ${q(table)} x`);
  const rows = r.rows[0].rows;
  return typeof rows === "string" ? (JSON.parse(rows) as Row[]) : rows;
}

/** Copies the real database's rows (except auth tables) into the empty PGlite copy. */
export async function copyToLocal(remote: postgres.Sql, local: PGlite, catalog: Catalog) {
  for (const table of catalog.order) {
    if (SKIP(table)) continue;
    const rows = await remoteRows(remote, table);
    if (!rows.length) continue;
    // Staff sign in through auth tables that are not copied.
    if (table === "staff_members") for (const r of rows) r.auth_user_id = null;
    const cols = catalog.columns.get(table)!.map(q).join(", ");
    await local.query(`INSERT INTO ${q(table)} (${cols}) SELECT ${cols} FROM json_populate_recordset(NULL::${q(table)}, $1::json)`, [JSON.stringify(rows)]);
  }
}

export async function snapshot(local: PGlite, catalog: Catalog): Promise<Snapshot> {
  const snap: Snapshot = new Map();
  for (const table of catalog.order) {
    if (SKIP(table)) continue;
    const key = catalog.keys.get(table)!;
    snap.set(table, new Map((await localRows(local, table)).map((r) => [keyOf(r, key), JSON.stringify(r)])));
  }
  return snap;
}

export type Changes = Array<{ table: string; upserts: Row[]; deletes: Row[] }>;

/** Rows added, changed or removed in PGlite since the snapshot. */
export async function diff(local: PGlite, catalog: Catalog, before: Snapshot, skip: string[] = []): Promise<Changes> {
  const out: Changes = [];
  for (const table of catalog.order) {
    if (SKIP(table) || skip.includes(table)) continue;
    const key = catalog.keys.get(table)!;
    const was = before.get(table)!;
    const rows = await localRows(local, table);
    const seen = new Set<string>();
    const upserts: Row[] = [];
    for (const r of rows) {
      const k = keyOf(r, key);
      seen.add(k);
      if (was.get(k) !== JSON.stringify(r)) upserts.push(r);
    }
    const deletes = [...was].filter(([k]) => !seen.has(k)).map(([, json]) => JSON.parse(json) as Row);
    if (upserts.length || deletes.length) out.push({ table, upserts, deletes });
  }
  return out;
}

/** Writes the changes to the real database in one transaction (parents first, deletions children first). postgres-js serialises the rows as json itself. */
export async function push(remote: postgres.Sql, catalog: Catalog, changes: Changes) {
  await remote.begin(async (tx) => {
    for (const { table, upserts } of changes) {
      const cols = catalog.columns.get(table)!;
      const key = catalog.keys.get(table)!;
      const list = cols.map(q).join(", ");
      const rest = cols.filter((c) => !key.includes(c));
      const onConflict = rest.length ? `DO UPDATE SET ${rest.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(", ")}` : "DO NOTHING";
      for (let i = 0; i < upserts.length; i += 400) {
        const chunk = upserts.slice(i, i + 400);
        await tx.unsafe(`INSERT INTO ${q(table)} (${list}) SELECT ${list} FROM json_populate_recordset(NULL::${q(table)}, $1::json) ON CONFLICT (${key.map(q).join(", ")}) ${onConflict}`, [chunk as never]);
      }
    }
    for (const { table, deletes } of [...changes].reverse()) {
      if (!deletes.length) continue;
      const key = catalog.keys.get(table)!.map(q).join(", ");
      await tx.unsafe(`DELETE FROM ${q(table)} WHERE (${key}) IN (SELECT ${key} FROM json_populate_recordset(NULL::${q(table)}, $1::json))`, [deletes as never]);
    }
  });
}
