/**
 * Removes the demo written by npm run demo:seed, and only that: demo guests
 * and everything on their bookings, demo owners, add-ons, promo codes,
 * tasks, expenses, report schedules and staff (demo-…@example.com), and
 * every record a demo staff member created. Puts back the property settings
 * the demo changed and the invoice counters. Real data stays as it is.
 *
 * Usage: npm run demo:clear
 */
import postgres from "postgres";

async function main() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DIRECT_URL or DATABASE_URL (see .env.example).");
  const sql = postgres(url, { prepare: false, max: 1 });
  try {
    const counts: Record<string, number> = {};
    await sql.begin(async (tx) => {
      const run = async (name: string, query: Promise<{ count: number }>) => {
        counts[name] = (counts[name] ?? 0) + (await query).count;
      };
      const staff = (await tx`SELECT id::text FROM staff_members WHERE email LIKE 'demo-%@example.com'`).map((r) => r.id as string);
      if (!staff.length) {
        console.log("No demo data found.");
        return;
      }
      const [seed] = await tx`SELECT before, occurred_at FROM audit_events WHERE action = 'demo.seeded' ORDER BY occurred_at DESC LIMIT 1`;
      const guests = (await tx`SELECT id::text FROM guests WHERE email LIKE 'demo-%@example.com'`).map((r) => r.id as string);
      const res = guests.length ? (await tx`SELECT id::text FROM reservations WHERE guest_id IN ${tx(guests)}`).map((r) => r.id as string) : [];
      const owners = (await tx`SELECT id::text FROM owners WHERE email LIKE 'demo-%@example.com' OR created_by IN ${tx(staff)}`).map((r) => r.id as string);
      const addons = (await tx`SELECT id::text FROM addons WHERE created_by IN ${tx(staff)}`).map((r) => r.id as string);
      const promos = (await tx`SELECT id::text FROM promo_codes WHERE created_by IN ${tx(staff)}`).map((r) => r.id as string);
      const tasks = (await tx`SELECT id::text FROM tasks WHERE created_by IN ${tx(staff)}${res.length ? tx` OR reservation_id IN ${tx(res)}` : tx``}`).map((r) => r.id as string);
      const blocks = (await tx`SELECT id::text FROM unit_blocks WHERE created_by IN ${tx(staff)}`).map((r) => r.id as string);

      if (res.length) {
        await run("payments", tx`DELETE FROM payments WHERE reservation_id IN ${tx(res)}`);
        await run("notification_outbox", tx`DELETE FROM notification_outbox WHERE reservation_id IN ${tx(res)}`);
      }
      await run("owner_expenses", tx`DELETE FROM owner_expenses WHERE created_by IN ${tx(staff)}${tasks.length ? tx` OR task_id IN ${tx(tasks)}` : tx``}`);
      await run("recurring_expenses", tx`DELETE FROM recurring_expenses WHERE created_by IN ${tx(staff)}`);
      if (owners.length) {
        await run("owner_statements", tx`DELETE FROM owner_statements WHERE owner_id IN ${tx(owners)}`);
        await run("unit_ownerships", tx`DELETE FROM unit_ownerships WHERE owner_id IN ${tx(owners)}`);
        await run("owners", tx`DELETE FROM owners WHERE id IN ${tx(owners)}`);
      }
      if (tasks.length) await run("tasks", tx`DELETE FROM tasks WHERE id IN ${tx(tasks)}`);
      if (blocks.length) await run("unit_blocks", tx`DELETE FROM unit_blocks WHERE id IN ${tx(blocks)}`);
      await run("housekeeping_events", tx`DELETE FROM housekeeping_events WHERE actor_id IN ${tx(staff)}`);
      await run("unit_status", tx`DELETE FROM unit_status WHERE updated_by IN ${tx(staff)}`);
      if (res.length) await run("reservations", tx`DELETE FROM reservations WHERE id IN ${tx(res)}`);
      if (addons.length) await run("addons", tx`DELETE FROM addons WHERE id IN ${tx(addons)}`);
      if (promos.length) await run("promo_codes", tx`DELETE FROM promo_codes WHERE id IN ${tx(promos)}`);
      if (guests.length) await run("guests", tx`DELETE FROM guests WHERE id IN ${tx(guests)}`);
      await run("report_subscriptions", tx`DELETE FROM report_subscriptions WHERE created_by IN ${tx(staff)} OR staff_id IN ${tx(staff)} OR email LIKE 'demo-%@example.com'`);
      if (seed) {
        // Reports the cron queued for the demo schedules.
        await run("report_runs", tx`DELETE FROM report_runs r WHERE r.created_at >= ${seed.occurred_at} AND NOT EXISTS (SELECT 1 FROM report_subscriptions s WHERE s.property_id = r.property_id AND s.kind = r.kind)`);
      }
      const entities = [...res, ...guests, ...owners, ...addons, ...promos, ...tasks, ...blocks];
      await run("audit_events", tx`DELETE FROM audit_events WHERE actor_id IN ${tx(staff)} OR action = 'demo.seeded'`);
      for (let i = 0; i < entities.length; i += 1000) await run("audit_events", tx`DELETE FROM audit_events WHERE entity_id IN ${tx(entities.slice(i, i + 1000))}`);

      // Invoice numbers continue from the last real invoice (or start again at 00001).
      for (const c of await tx`SELECT property_id, year FROM invoice_counters`) {
        const [last] = await tx`SELECT max(substring(i.number from '([0-9]+)$')::int) AS n FROM invoices i JOIN reservations r ON r.id = i.reservation_id
          WHERE r.property_id = ${c.property_id} AND i.number LIKE ${`%-${c.year}-%`}`;
        if (last?.n) await tx`UPDATE invoice_counters SET last = ${last.n} WHERE property_id = ${c.property_id} AND year = ${c.year}`;
        else await run("invoice_counters", tx`DELETE FROM invoice_counters WHERE property_id = ${c.property_id} AND year = ${c.year}`);
      }
      // The offers and channel commissions the demo switched on.
      for (const p of (seed?.before as Array<Record<string, unknown>> | undefined) ?? []) {
        await tx`UPDATE properties SET non_refundable_bp = ${p.nonRefundableBp as number | null}, breakfast_per_guest = ${p.breakfastPerGuest as number | null}, early_bird_days = ${p.earlyBirdDays as number | null}, early_bird_bp = ${p.earlyBirdBp as number | null},
          long_stay_tiers = ${tx.json((p.longStayTiers ?? []) as postgres.JSONValue)}, commission_rates = ${tx.json((p.commissionRates ?? {}) as postgres.JSONValue)}, updated_at = now() WHERE id = ${p.id as string}`;
      }
      await run("staff_members", tx`DELETE FROM staff_members WHERE id IN ${tx(staff)}`);
    });
    if (Object.keys(counts).length) console.log("Removed:", counts);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
