/**
 * Fills the database with a fictional demo: a year of stays and the next four
 * months on the books for every villa, guests (some returning, tagged),
 * payments, cancellations and no-shows, today's arrivals, departures and
 * housekeeping, requests waiting for staff, add-ons, promo codes, villa owners
 * with locked and paid statements, and report schedules.
 *
 * Usage: npm run demo:seed   (add -- --dry-run to build it without writing)
 * Remove before launch with: npm run demo:clear
 *
 * Everything is created by the real domain code, run against an in-memory
 * copy of the database (PGlite, same migrations); then only the new and
 * changed rows are written to the real database in one transaction.
 * Demo records are recognisable: guests, staff and owners use
 * demo-…@example.com, and every staff action is by a demo staff member.
 */
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { and, eq, inArray, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import postgres from "postgres";
import * as schema from "../../src/db/schema";
import { addAddonByStaff, confirmAddonOrder, createAddon, requestAddonAsGuest, type AddonChoice } from "../../src/domain/addons";
import { cancelReservation, createHold, createPendingPayment, recordPaymentPaid } from "../../src/domain/booking";
import { requestDateChangeAsGuest } from "../../src/domain/date-change";
import { addDays, todayIn } from "../../src/domain/dates";
import { decideEarlyCheckin, requestEarlyCheckin, requestEarlyCheckinAsGuest } from "../../src/domain/early-checkin";
import { addCharge, issueInvoice } from "../../src/domain/folio";
import { updateGuest } from "../../src/domain/guests";
import { decideLateCheckout, requestLateCheckout, requestLateCheckoutAsGuest } from "../../src/domain/late-checkout";
import { checkIn, checkOut, markNoShow, recordManualPayment, recordRefundPayout, type PaymentMethod } from "../../src/domain/operations";
import { addExpense, addRecurring, assignUnit, createOwner, lockStatement, markStatementPaid, nextMonth, setCommissionRates } from "../../src/domain/owners";
import { balanceDue } from "../../src/domain/pricing";
import { createPromo, updateOffers } from "../../src/domain/rates";
import { addSubscription } from "../../src/domain/report-schedule";
import { createStaffBooking } from "../../src/domain/staff-booking";
import { assignTask, claimTask, finishCleaning, finishInspection, finishTask, reportMaintenance, startTask } from "../../src/domain/tasks";
import type { RatePlan } from "../../src/domain/types";
import idDict from "../../src/i18n/dictionaries/id.json";
import { GUEST_NOTES, guestFactory, REQUESTS, rng, type DemoGuest } from "./people";
import { copyToLocal, diff, push, readCatalog, snapshot } from "./sync";

const DRY_RUN = process.argv.includes("--dry-run");
const TZ = "Asia/Makassar";
const now = new Date();
const T = todayIn(TZ, now);
const r = rng(20261126);
const newGuest = guestFactory(r);

const at = (date: string, time: string) => new Date(`${date}T${time}:00+08:00`);
/** Times planned "today" never lie in the future. */
const past = (d: Date) => (d.getTime() > now.getTime() - 60_000 ? new Date(now.getTime() - 60_000) : d);
const minutesBefore = (m: number) => new Date(now.getTime() - m * 60_000);
const month = (date: string) => date.slice(0, 7);
const addMonths = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
const START = `${addMonths(month(T), -12)}-01`;
const END = `${addMonths(month(T), 5)}-01`;
const PEAK = (date: string) => date >= "2026-12-20" && date < "2027-01-05";

const failures = new Map<string, number>();
function fail(what: string, detail?: unknown) {
  failures.set(what, (failures.get(what) ?? 0) + 1);
  if ((failures.get(what) ?? 0) <= 2) console.warn(`  ! ${what}`, detail === undefined ? "" : JSON.stringify(detail));
}

type Source = (typeof schema.bookingSource.enumValues)[number];
type Actor = { type: "staff"; id: string };
type Unit = { id: string; code: string; unitTypeId: string; maxGuests: number; minStay: number; propertyId: string; property: string; typeSlug: string };
type Stay = {
  unit: Unit;
  checkIn: string;
  checkOut: string;
  fate: "stay" | "cancel" | "noshow";
  tag?: string;
  source: Source;
  createdAt: Date;
  cancelAt?: Date;
  guest?: DemoGuest;
  adults: number;
  children: number;
  plan: RatePlan;
  promo: string | null;
  request: string | null;
  pay: "deposit" | "full";
  addons?: AddonChoice[];
  id?: string;
  code?: string;
};

/** The scene around today, per villa (days from today). Elsewhere stays are random. */
const SCRIPT: Record<string, { stays: Array<{ ci: number; co: number; tag: string; source?: Source; lead?: number; request?: string }>; until: number }> = {
  "UBD-RVP-01": { stays: [{ ci: -3, co: 0, tag: "late-approved" }, { ci: 1, co: 5, tag: "early-request" }], until: 5 },
  "UBD-RVP-02": { stays: [{ ci: -2, co: 2, tag: "late-request" }], until: 2 },
  "UBD-RVP-03": { stays: [{ ci: -4, co: 0, tag: "cleaning" }, { ci: 0, co: 3, tag: "arrival", request: REQUESTS[0] }], until: 3 },
  "UBD-CNP-01": { stays: [{ ci: -5, co: -1, tag: "done" }, { ci: 0, co: 4, tag: "early-checked-in" }], until: 4 },
  "UBD-CNP-02": { stays: [{ ci: -6, co: -2, tag: "done" }, { ci: 0, co: 3, tag: "vip-arrival", lead: 45 }], until: 3 },
  "CGU-RPV-01": { stays: [{ ci: -4, co: 2, tag: "addon-request" }], until: 2 },
  "CGU-RPV-02": { stays: [{ ci: -3, co: 0, tag: "inspection" }, { ci: 1, co: 4, tag: "future" }], until: 4 },
  "CGU-RPV-03": { stays: [{ ci: -5, co: -1, tag: "done" }], until: 3 },
  "CGU-FME-01": { stays: [{ ci: -5, co: -2, tag: "done" }, { ci: 1, co: 6, tag: "guarantee", source: "agent", lead: 6 }], until: 6 },
};

const OCCUPANCY = [0.55, 0.45, 0.5, 0.6, 0.62, 0.72, 0.88, 0.9, 0.75, 0.65, 0.55, 0.82];
const LENGTHS = [[1, 8], [2, 20], [3, 25], [4, 17], [5, 12], [6, 6], [7, 8], [10, 3], [14, 1]] as const;
const SOURCES = [["website", 35], ["ota", 30], ["agent", 15], ["direct", 15], ["walk_in", 5]] as const;

function leadDays(source: Source) {
  if (source === "walk_in") return 0;
  const mean = source === "agent" ? 70 : source === "direct" ? 35 : source === "ota" ? 45 : 50;
  return Math.min(240, Math.max(1, Math.round(-Math.log(1 - r.next()) * mean)));
}

/** Random stays in [from, to): gaps follow the month's occupancy. */
function fill(unit: Unit, from: string, to: string): Array<{ checkIn: string; checkOut: string }> {
  const out: Array<{ checkIn: string; checkOut: string }> = [];
  let d = from;
  for (;;) {
    const occ = OCCUPANCY[Number(d.slice(5, 7)) - 1] * (unit.typeSlug === "family-estate" ? 0.75 : 1);
    const gap = Math.round(-Math.log(1 - r.next()) * ((3.6 * (1 - occ)) / occ));
    const ci = addDays(d, gap);
    let len: number = r.weighted(LENGTHS);
    len = Math.max(len, unit.minStay, PEAK(ci) ? 5 : 1);
    const co = addDays(ci, len);
    if (co > to) break;
    out.push({ checkIn: ci, checkOut: co });
    d = co;
  }
  return out;
}

async function main() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DIRECT_URL or DATABASE_URL (see .env.example).");
  const remote = postgres(url, { prepare: false, max: 1 });
  try {
    const [{ count }] = await remote`SELECT count(*)::int AS count FROM staff_members WHERE email LIKE 'demo-%@example.com'`;
    if (count > 0) throw new Error("Demo data is already there. Run npm run demo:clear first.");

    console.log(`Demo for ${START} – ${END} (today ${T}). Copying the database into memory…`);
    const local = new PGlite({ extensions: { btree_gist } });
    const db = drizzle(local, { schema });
    await migrate(db, { migrationsFolder: "drizzle" });
    const catalog = await readCatalog(local);
    await copyToLocal(remote, local, catalog);
    const before = await snapshot(local, catalog);

    await build(db);

    const changes = await diff(local, catalog, before, ["notification_outbox"]);
    console.log("Rows to write:");
    for (const c of changes) console.log(`  ${c.table}: ${c.upserts.length}${c.deletes.length ? `, delete ${c.deletes.length}` : ""}`);
    if (failures.size) console.log("Skipped steps:", Object.fromEntries(failures));
    if (DRY_RUN) {
      console.log("Dry run: nothing written.");
    } else {
      await push(remote, catalog, changes);
      console.log("Demo written. Remove it before launch with: npm run demo:clear");
    }
    await local.close();
  } finally {
    await remote.end();
  }
}

type Db = ReturnType<typeof drizzle<typeof schema>>;

async function build(db: Db) {
  // ---------------------------------------------------------------- setup
  const properties = await db.select().from(schema.properties);
  const ubud = properties.find((p) => p.slug === "ubud");
  const canggu = properties.find((p) => p.slug === "canggu");
  if (!ubud || !canggu) throw new Error("Expected the Ubud and Canggu properties.");
  const units: Unit[] = (
    await db
      .select({ id: schema.units.id, code: schema.units.code, unitTypeId: schema.units.unitTypeId, maxGuests: schema.unitTypes.maxGuests, minStay: schema.unitTypes.minStayNights, propertyId: schema.units.propertyId, typeSlug: schema.unitTypes.slug })
      .from(schema.units)
      .innerJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.units.unitTypeId))
      .orderBy(schema.units.code)
  ).map((u) => ({ ...u, property: u.propertyId === ubud.id ? "ubud" : "canggu" }));

  const staff = {
    ubud: { manager: "Made Suardana", fo: "Putu Ariani", hk: "Wayan Sudarta" },
    canggu: { manager: "Komang Ayu Lestari", fo: "Gede Pratama", hk: "Nyoman Sari" },
  };
  const roles = { manager: "branch_manager", fo: "front_office", hk: "housekeeping" } as const;
  const actors = {} as Record<"ubud" | "canggu", Record<"manager" | "fo" | "hk", Actor>>;
  for (const [prop, people] of Object.entries(staff) as Array<["ubud" | "canggu", Record<"manager" | "fo" | "hk", string>]>) {
    actors[prop] = {} as Record<"manager" | "fo" | "hk", Actor>;
    for (const [role, fullName] of Object.entries(people) as Array<["manager" | "fo" | "hk", string]>) {
      const id = randomUUID();
      // No sign-in account: demo staff cannot log in.
      await db.insert(schema.staffMembers).values({ id, email: `demo-${role}.${prop}@example.com`, fullName, role: roles[role], createdAt: at(START, "09:00"), updatedAt: at(START, "09:00") });
      await db.insert(schema.staffPropertyAccess).values({ staffId: id, propertyId: prop === "ubud" ? ubud.id : canggu.id });
      actors[prop][role] = { type: "staff", id };
    }
  }
  const A = (u: Unit) => actors[u.property as "ubud" | "canggu"];

  // The settings demo:clear puts back.
  await db.insert(schema.auditEvents).values({
    actorType: "staff",
    actorId: actors.ubud.manager.id,
    entityType: "demo",
    entityId: "seed",
    action: "demo.seeded",
    before: properties.map((p) => ({ id: p.id, nonRefundableBp: p.nonRefundableBp, breakfastPerGuest: p.breakfastPerGuest, earlyBirdDays: p.earlyBirdDays, earlyBirdBp: p.earlyBirdBp, longStayTiers: p.longStayTiers, commissionRates: p.commissionRates })),
    after: { seededAt: now.toISOString(), today: T },
    occurredAt: now,
  });

  for (const p of [ubud, canggu]) {
    const actor = actors[p.slug as "ubud" | "canggu"].manager;
    await updateOffers(db, { propertyId: p.id, nonRefundableBp: 1000, breakfastPerGuest: 250_000, earlyBirdDays: 60, earlyBirdBp: 1000, longStayTiers: [{ minNights: 7, bp: 1000 }, { minNights: 14, bp: 1500 }], actor });
    await setCommissionRates(db, { propertyId: p.id, rates: { ota: 1500, agent: 1000 }, actor });
    await createPromo(db, { propertyId: p.id, code: "WELCOME10", kind: "percent", valueBp: 1000, amount: null, bookFrom: null, bookUntil: null, stayFrom: null, stayUntil: null, minNights: null, unitTypeIds: [], maxUses: null, note: "Tamu baru dari Instagram", actor });
    await createPromo(db, { propertyId: p.id, code: "BALI500", kind: "amount", valueBp: null, amount: 500_000, bookFrom: null, bookUntil: null, stayFrom: null, stayUntil: null, minNights: 3, unitTypeIds: [], maxUses: 100, note: "Newsletter", actor });
  }

  const addonIds: Record<string, Record<string, string>> = { ubud: {}, canggu: {} };
  const ADDONS = [
    { key: "chef", name: { id: "Makan malam chef pribadi", en: "Private chef dinner" }, category: "food_beverage", pricing: "per_person", price: 450_000, needsTime: true, leadHours: 24 },
    { key: "massage", name: { id: "Pijat Bali 90 menit", en: "Balinese massage, 90 minutes" }, category: "spa", pricing: "per_person", price: 650_000, needsTime: true, leadHours: 6 },
    { key: "transfer", name: { id: "Antar-jemput bandara", en: "Airport transfer" }, category: "transfer", pricing: "per_booking", price: 750_000, needsTime: true, leadHours: 24 },
    { key: "breakfast", name: { id: "Sarapan terapung", en: "Floating breakfast" }, category: "food_beverage", pricing: "per_person", price: 350_000, needsTime: true, leadHours: 12 },
    { key: "surf", name: { id: "Les selancar", en: "Surf lesson" }, category: "tour", pricing: "per_person", price: 550_000, needsTime: true, leadHours: 12, only: "canggu" },
  ];
  for (const p of [ubud, canggu]) {
    let sort = 0;
    for (const a of ADDONS) {
      if (a.only && a.only !== p.slug) continue;
      const made = await createAddon(db, { propertyId: p.id, name: a.name, description: null, category: a.category, pricing: a.pricing, price: a.price, needsTime: a.needsTime, leadHours: a.leadHours, sortOrder: sort++, actor: actors[p.slug as "ubud" | "canggu"].manager });
      if (made.ok) addonIds[p.slug][a.key] = made.id;
      else fail("addon.create", a.key);
    }
  }

  // ---------------------------------------------------------------- plan
  const plans: Stay[] = [];
  const attrs = (unit: Unit, source: Source): Omit<Stay, "unit" | "checkIn" | "checkOut" | "fate" | "createdAt"> => {
    const adults = unit.maxGuests <= 2 ? r.weighted([[2, 9], [1, 1]] as const) : unit.maxGuests >= 8 ? r.int(4, 6) : r.int(2, 3);
    const children = unit.maxGuests <= 2 ? 0 : Math.min(unit.maxGuests - adults, r.weighted([[0, 6], [1, 2], [2, 2]] as const));
    const plan: RatePlan =
      source === "website" ? r.weighted([["standard", 70], ["non_refundable", 15], ["breakfast", 15]] as const) : source === "ota" || source === "agent" ? r.weighted([["standard", 80], ["breakfast", 20]] as const) : "standard";
    const promo = source === "website" && plan !== "non_refundable" ? r.weighted([[null, 89], ["WELCOME10", 8], ["BALI500", 3]] as const) : null;
    // BALI500 needs 3 nights: checked once the stay is known (see below).
    const pay: Stay["pay"] = source === "ota" || source === "walk_in" || plan === "non_refundable" ? "full" : source === "agent" ? "deposit" : r.chance(0.35) ? "full" : "deposit";
    return { source, adults, children, plan, promo, pay, request: r.chance(0.14) ? r.pick(REQUESTS) : null };
  };
  const createdFor = (source: Source, ci: string, lead = leadDays(source)) => (source === "walk_in" ? at(ci, "13:00") : at(addDays(ci, -lead), `${String(r.int(8, 21)).padStart(2, "0")}:${String(r.int(0, 59)).padStart(2, "0")}`));

  for (const unit of units) {
    const script = SCRIPT[unit.code];
    const windowStart = script ? addDays(T, Math.min(...script.stays.map((s) => s.ci), script.until)) : T;
    const windowEnd = script ? addDays(T, script.until) : T;
    const random = [...fill(unit, START, windowStart), ...fill(unit, windowEnd, END)];
    for (const s of random) {
      const source: Source = r.weighted(SOURCES);
      const createdAt = createdFor(source, s.checkIn);
      if (createdAt > now || (source === "walk_in" && s.checkIn >= T)) continue; // not booked yet
      plans.push({ unit, ...s, fate: "stay", createdAt, ...attrs(unit, source) });
    }
    for (const s of script?.stays ?? []) {
      const source = s.source ?? "website";
      const a = attrs(unit, source);
      plans.push({ unit, checkIn: addDays(T, s.ci), checkOut: addDays(T, s.co), fate: "stay", tag: s.tag, createdAt: createdFor(source, addDays(T, s.ci), s.lead ?? r.int(10, 40)), ...a, pay: s.tag === "guarantee" ? "deposit" : a.pay, request: s.request ?? null });
    }
    // Cancellations and no-shows fill some of the gaps.
    const taken = plans.filter((p) => p.unit === unit).sort((x, y) => (x.checkIn < y.checkIn ? -1 : 1));
    let free = START;
    for (const p of [...taken, null]) {
      const gapEnd = p ? p.checkIn : END;
      const nights = Math.round((Date.parse(gapEnd) - Date.parse(free)) / 86_400_000);
      const outsideWindow = gapEnd <= windowStart || free >= windowEnd;
      if (nights >= 4 && outsideWindow) {
        const ci = addDays(free, 1);
        const co = addDays(ci, Math.max(unit.minStay, Math.min(nights - 2, r.int(2, 4))));
        if (!PEAK(ci) && co < gapEnd) {
          if (ci < addDays(T, -1) && r.chance(0.05)) {
            const source: Source = r.pick(["website", "ota", "agent"] as const);
            const createdAt = createdFor(source, ci);
            plans.push({ unit, checkIn: ci, checkOut: co, fate: "noshow", createdAt, ...attrs(unit, source) });
          } else if (r.chance(0.22)) {
            const source: Source = r.weighted([["website", 5], ["ota", 4], ["agent", 1]] as const);
            const createdAt = createdFor(source, ci);
            const latest = Math.min(at(addDays(ci, -1), "12:00").getTime(), now.getTime() - 3_600_000);
            if (createdAt.getTime() < latest - 86_400_000) {
              const cancelAt = new Date(createdAt.getTime() + 86_400_000 + r.next() * (latest - createdAt.getTime() - 86_400_000));
              plans.push({ unit, checkIn: ci, checkOut: co, fate: "cancel", createdAt, cancelAt, ...attrs(unit, source) });
            }
          }
        }
      }
      if (p) free = p.checkOut;
    }
  }
  // The newest future cancellation happened yesterday: its refund is still owed.
  const recent = plans.filter((p) => p.fate === "cancel" && p.checkIn > addDays(T, 7) && p.createdAt < minutesBefore(3 * 24 * 60)).sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0];
  if (recent) {
    recent.cancelAt = minutesBefore(20 * 60);
    recent.source = "website";
    recent.pay = "full";
    recent.plan = "standard";
  }

  for (const p of plans) if (p.promo === "BALI500" && Math.round((Date.parse(p.checkOut) - Date.parse(p.checkIn)) / 86_400_000) < 3) p.promo = "WELCOME10";
  // Guests: a few regulars come back several times; some others return once.
  plans.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
  const regulars = [newGuest("AU"), newGuest("GB"), newGuest("ID"), newGuest("SG"), newGuest("US"), newGuest("DE")];
  const seen: DemoGuest[] = [];
  for (const p of plans) {
    if (p.tag === "vip-arrival") p.guest = regulars[0];
    else if (r.chance(0.012)) p.guest = r.pick(regulars);
    else if (seen.length > 20 && r.chance(0.06)) p.guest = r.pick(seen);
    else p.guest = newGuest();
    seen.push(p.guest);
  }
  // Regular[0] (VIP) must have stayed before: give them two earlier Ubud stays.
  for (const p of plans.filter((x) => x.unit.property === "ubud" && x.fate === "stay" && !x.tag && x.checkOut < addDays(T, -30) && x.adults <= 2).slice(-40, -38)) p.guest = regulars[0];
  // A few future website bookings asked for an airport transfer at checkout.
  for (const p of plans.filter((x) => x.fate === "stay" && !x.tag && x.source === "website" && x.checkIn > addDays(T, 5)).filter(() => r.chance(0.12))) {
    p.addons = [{ addonId: addonIds[p.unit.property].transfer, serviceDate: p.checkIn, serviceTime: "14:00" }];
  }
  console.log(`Planned ${plans.length} bookings (${plans.filter((p) => p.fate === "cancel").length} cancelled, ${plans.filter((p) => p.fate === "noshow").length} no-shows).`);

  // ---------------------------------------------------------------- phase 1: bookings and payments, in booking order
  const methods: PaymentMethod[] = ["bank_transfer", "card", "card", "cash"];
  for (const [i, s] of plans.entries()) {
    if (i % 100 === 0) console.log(`  booking ${i}/${plans.length}`);
    const g = s.guest!;
    const base = {
      unitTypeId: s.unit.unitTypeId,
      checkIn: s.checkIn,
      checkOut: s.checkOut,
      adults: s.adults,
      children: s.children,
      guest: { fullName: g.fullName, email: g.email, phone: g.phone, countryCode: g.countryCode },
      specialRequests: s.request,
      estimatedArrival: r.pick(["14:00", "15:00", "16:00", "18:00", null]),
      locale: g.locale,
      now: s.createdAt,
      ratePlan: s.plan,
      promoCode: s.promo,
      addons: s.addons,
    };
    if (s.source === "website" || s.source === "ota") {
      const h = await createHold(db, { ...base, source: s.source, candidateUnitIds: [s.unit.id], holdMinutes: 60 });
      if (!h.ok) {
        fail(`hold.${h.error.kind}`, { unit: s.unit.code, ci: s.checkIn, co: s.checkOut });
        continue;
      }
      const res = h.reservation;
      const paidAt = new Date(s.createdAt.getTime() + 4 * 60_000);
      if (s.source === "website") {
        const amount = s.pay === "full" ? res.totalAmount : res.depositAmount;
        const ref = `demo_${res.code}`;
        await createPendingPayment(db, { reservationId: res.id, provider: "simulated", providerRef: ref, purpose: amount === res.totalAmount ? "full" : "deposit", amount, checkoutUrl: null, expiresAt: null });
        await recordPaymentPaid(db, { provider: "simulated", providerRef: ref, amount, paidAt });
      } else {
        const paid = await recordManualPayment(db, { reservationId: res.id, amount: res.totalAmount, method: "other", reference: `${r.pick(["Booking.com", "Agoda", "Airbnb", "Expedia"])} prepaid`, actor: A(s.unit).fo, now: paidAt });
        if (!paid.ok) fail(`ota.pay.${paid.error}`);
      }
      s.id = res.id;
      s.code = res.code;
    } else {
      const source = s.source as "direct" | "walk_in" | "agent";
      const input = { ...base, source, unitId: s.unit.id, actorId: A(s.unit).fo.id, role: "front_office" };
      let made =
        s.tag === "guarantee"
          ? await createStaffBooking(db, { ...input, actorId: A(s.unit).manager.id, role: "branch_manager", payment: { kind: "guarantee", reason: "Agen langganan, deposit menyusul lewat transfer", payBy: addDays(T, -1) } })
          : await createStaffBooking(db, { ...input, payment: { kind: "received", amount: 1, method: "bank_transfer" } });
      if (!made.ok && made.error.kind === "invalid_amount") {
        const amount = s.pay === "full" ? made.error.total : made.error.dueNow;
        made = await createStaffBooking(db, { ...input, payment: { kind: "received", amount, method: source === "walk_in" ? r.pick(["cash", "card"] as const) : "bank_transfer", reference: source === "agent" ? `Agent ${r.pick(["Bali Holidays", "Panorama Tours", "Asia Escape"])}` : null } });
      }
      if (!made.ok) {
        fail(`staff.${made.error.kind}`, { unit: s.unit.code, ci: s.checkIn });
        continue;
      }
      s.id = made.reservation.id;
      s.code = made.reservation.code;
    }
  }

  const reservation = async (id: string) => (await db.select().from(schema.reservations).where(eq(schema.reservations.id, id)))[0];
  async function payBalance(s: Stay, when: Date, method: PaymentMethod = r.pick(methods)) {
    const res = await reservation(s.id!);
    const due = balanceDue(res);
    if (due <= 0 || !["confirmed", "in_house"].includes(res.status)) return;
    const paid = await recordManualPayment(db, { reservationId: res.id, amount: due, method, reference: method === "bank_transfer" ? `TRF ${s.code}` : null, actor: A(s.unit).fo, now: past(when) });
    if (!paid.ok) fail(`balance.${paid.error}`);
  }
  const openTask = async (unitId: string, kind: "clean" | "inspect") =>
    (await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(eq(schema.tasks.unitId, unitId), eq(schema.tasks.kind, kind), inArray(schema.tasks.status, ["open", "in_progress"]))))[0]?.id;
  const checklist = Object.values(idDict.tasks.defaultChecklist);
  async function clean(unit: Unit, when: Date) {
    const id = await openTask(unit.id, "clean");
    if (!id) return fail("clean.missing");
    await claimTask(db, { taskId: id, actor: A(unit).hk, now: past(new Date(when.getTime() - 45 * 60_000)) });
    const done = await finishCleaning(db, { taskId: id, actor: A(unit).hk, now: past(when) });
    if (!done.ok) fail(`clean.${done.error}`);
  }
  async function inspect(unit: Unit, when: Date) {
    const id = await openTask(unit.id, "inspect");
    if (!id) return fail("inspect.missing");
    const done = await finishInspection(db, { taskId: id, checklist, ticked: checklist, passed: true, actor: A(unit).manager, now: past(when) });
    if (!done.ok) fail(`inspect.${done.error}`);
  }
  async function finishRequests(s: Stay, when: Date) {
    const open = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(eq(schema.tasks.reservationId, s.id!), eq(schema.tasks.kind, "request"), inArray(schema.tasks.status, ["open", "in_progress"])));
    for (const t of open) await finishTask(db, { taskId: t.id, actor: A(s.unit).fo, now: past(when) });
  }

  // ---------------------------------------------------------------- phase 2: cancellations
  for (const s of plans.filter((p) => p.fate === "cancel" && p.id).sort((x, y) => x.cancelAt!.getTime() - y.cancelAt!.getTime())) {
    const done = await cancelReservation(db, { reservationId: s.id!, actor: { type: "guest" }, reason: r.pick(["Perubahan rencana perjalanan", "Flight cancelled", "Family emergency", "Found a different date"]), now: s.cancelAt });
    if (!done.ok) {
      fail(`cancel.${done.error}`);
      continue;
    }
    if (done.refund > 0 && s.cancelAt!.getTime() < now.getTime() - 5 * 86_400_000) {
      await recordRefundPayout(db, { reservationId: s.id!, amount: done.refund, reference: `REFUND ${s.code}`, actor: A(s.unit).manager, now: new Date(s.cancelAt!.getTime() + 2 * 86_400_000) });
    }
  }

  // ---------------------------------------------------------------- phase 3: stays, villa by villa in date order
  const limitInvoices = addDays(T, -45);
  for (const unit of units) {
    const stays = plans.filter((p) => p.unit === unit && p.id && p.fate !== "cancel").sort((x, y) => (x.checkIn < y.checkIn ? -1 : 1));
    for (const s of stays) {
      if (s.fate === "noshow") {
        const done = await markNoShow(db, { reservationId: s.id!, actor: A(unit).fo, now: at(addDays(s.checkIn, 1), "10:00") });
        if (!done.ok) fail(`noshow.${done.error}`);
        continue;
      }
      const res = await reservation(s.id!);
      if (s.checkIn >= T) {
        // Upcoming: the balance is paid once it falls due.
        if (res.balanceDueDate && res.balanceDueDate <= T && res.depositAmount < res.totalAmount && s.tag !== "guarantee") await payBalance(s, at(res.balanceDueDate, "10:00"), "bank_transfer");
        continue;
      }
      await payBalance(s, at(res.balanceDueDate && res.balanceDueDate < s.checkIn ? res.balanceDueDate : s.checkIn, "10:00"));
      const came = await checkIn(db, { reservationId: s.id!, actor: A(unit).fo, now: at(s.checkIn, "15:00") });
      if (!came.ok) {
        fail(`checkin.${came.error}`, { unit: unit.code, ci: s.checkIn });
        continue;
      }
      await finishRequests(s, at(s.checkIn, "17:00"));
      if (r.chance(0.2)) {
        const key = r.pick(unit.property === "canggu" ? ["chef", "massage", "surf", "breakfast"] : ["chef", "massage", "breakfast"]);
        const serviceDate = addDays(s.checkIn, 1) < s.checkOut ? addDays(s.checkIn, 1) : s.checkIn;
        const time = key === "chef" ? "19:00" : key === "breakfast" ? "08:00" : "10:00";
        const added = await addAddonByStaff(db, { reservationId: s.id!, choice: { addonId: addonIds[unit.property][key], serviceDate, serviceTime: time, persons: s.adults }, actor: A(unit).fo, now: at(s.checkIn, "16:00") });
        if (added.ok && at(serviceDate, time) < now) {
          const [task] = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(eq(schema.tasks.source, `addon:${added.orderId}`));
          if (task) await finishTask(db, { taskId: task.id, actor: A(unit).fo, now: new Date(at(serviceDate, time).getTime() + 2 * 3_600_000) });
        } else if (!added.ok) fail(`addon.staff.${added.error}`);
      }
      const extraAt = at(addDays(s.checkOut, -1), "20:00");
      if (r.chance(0.3) && extraAt < now) {
        const extra = r.pick([
          { category: "minibar", description: "Minibar", quantity: r.int(1, 3), unitPrice: 185_000 },
          { category: "laundry", description: "Laundry", quantity: 1, unitPrice: r.pick([150_000, 220_000]) },
          { category: "food_beverage", description: "In-villa dinner", quantity: 1, unitPrice: r.pick([680_000, 920_000]) },
        ]);
        const charged = await addCharge(db, { reservationId: s.id!, ...extra, actor: A(unit).fo, now: extraAt });
        if (!charged.ok) fail(`charge.${charged.error}`);
      }
      if (s.checkOut < T) {
        await payBalance(s, at(s.checkOut, "10:30"), "card");
        const left = await checkOut(db, { reservationId: s.id!, actor: A(unit).fo, now: at(s.checkOut, "11:00") });
        if (!left.ok) {
          fail(`checkout.${left.error}`);
          continue;
        }
        await clean(unit, at(s.checkOut, "12:45"));
        await inspect(unit, at(s.checkOut, "13:30"));
        if (s.checkOut >= limitInvoices) {
          const inv = await issueInvoice(db, { reservationId: s.id!, actor: A(unit).fo, now: at(s.checkOut, "11:05") });
          if (!inv.ok) fail(`invoice.${inv.error}`);
        }
      }
    }
  }

  // ---------------------------------------------------------------- phase 4: today
  const byTag = (tag: string) => plans.find((p) => p.tag === tag && p.id);
  const unitByCode = (code: string) => units.find((u) => u.code === code)!;
  {
    const s = byTag("late-approved");
    if (s) {
      const asked = await requestLateCheckout(db, { reservationId: s.id!, time: "16:00", note: "Penerbangan pukul 21:00", actor: A(s.unit).fo, now: past(at(T, "08:30")) });
      if (asked.ok) await decideLateCheckout(db, { reservationId: s.id!, approve: true, fee: 750_000, actor: A(s.unit).manager, now: past(at(T, "09:00")) });
      else fail(`late.staff.${asked.error}`);
    }
  }
  {
    const s = byTag("early-request");
    if (s) {
      let ok = false;
      for (const time of ["12:00", "13:00", "11:00", "10:00"]) {
        const asked = await requestEarlyCheckinAsGuest(db, { reservationId: s.id!, time, note: "Landing at 08:00, would love to rest", now: minutesBefore(120) });
        if ((ok = asked.ok)) break;
      }
      if (!ok) fail("early.guest");
    }
  }
  {
    const s = byTag("late-request");
    if (s) {
      let ok = false;
      for (const time of ["15:00", "14:00", "16:00", "13:00"]) {
        const asked = await requestLateCheckoutAsGuest(db, { reservationId: s.id!, time, note: "Our flight is in the evening", now: minutesBefore(75) });
        if ((ok = asked.ok)) break;
      }
      if (!ok) fail("late.guest");
    }
  }
  for (const tag of ["cleaning", "inspection"]) {
    const s = byTag(tag);
    if (!s) continue;
    await payBalance(s, at(T, "10:30"), "card");
    const left = await checkOut(db, { reservationId: s.id!, actor: A(s.unit).fo, now: past(at(T, tag === "cleaning" ? "11:00" : "10:40")) });
    if (!left.ok) {
      fail(`checkout.today.${left.error}`);
      continue;
    }
    const task = await openTask(s.unit.id, "clean");
    if (!task) continue;
    if (tag === "cleaning") {
      await assignTask(db, { taskId: task, assigneeId: A(s.unit).hk.id, actor: A(s.unit).manager, now: past(at(T, "11:10")) });
      await startTask(db, { taskId: task, actor: A(s.unit).hk, now: past(at(T, "11:40")) });
    } else {
      await clean(s.unit, at(T, "12:30"));
    }
  }
  {
    const s = byTag("early-checked-in");
    if (s) {
      const asked = await requestEarlyCheckin(db, { reservationId: s.id!, time: "12:00", note: "Tamu tiba dari Singapura pagi hari", actor: A(s.unit).fo, now: past(at(addDays(T, -1), "16:00")) });
      if (asked.ok) await decideEarlyCheckin(db, { reservationId: s.id!, approve: true, fee: 500_000, actor: A(s.unit).manager, now: past(at(addDays(T, -1), "17:00")) });
      else fail(`early.staff.${asked.error}`);
      if (now >= at(T, "12:10")) {
        await payBalance(s, at(T, "12:00"), "card");
        const came = await checkIn(db, { reservationId: s.id!, actor: A(s.unit).fo, now: at(T, "12:05") });
        if (!came.ok) fail(`checkin.early.${came.error}`);
      }
    }
  }
  {
    const s = byTag("vip-arrival");
    if (s) {
      const transfer = await addAddonByStaff(db, { reservationId: s.id!, choice: { addonId: addonIds.ubud.transfer, serviceDate: T, serviceTime: "13:00" }, actor: A(s.unit).fo, now: at(addDays(T, -2), "10:00") });
      if (!transfer.ok) fail(`addon.vip.${transfer.error}`);
      const chef = await requestAddonAsGuest(db, { reservationId: s.id!, choice: { addonId: addonIds.ubud.chef, serviceDate: addDays(T, 1), serviceTime: "19:00", persons: 2, note: "Seafood, no pork please" }, now: minutesBefore(180) });
      if (!chef.ok) fail(`addon.chef.${chef.error}`);
    }
  }
  {
    const s = byTag("addon-request");
    if (s) {
      const massage = await requestAddonAsGuest(db, { reservationId: s.id!, choice: { addonId: addonIds.canggu.massage, serviceDate: addDays(T, 1), serviceTime: "16:00", persons: 2 }, now: minutesBefore(90) });
      if (!massage.ok) fail(`addon.massage.${massage.error}`);
      await addCharge(db, { reservationId: s.id!, category: "minibar", description: "Minibar", quantity: 2, unitPrice: 185_000, actor: A(s.unit).fo, now: past(at(addDays(T, -1), "21:00")) });
    }
  }
  {
    const unit = unitByCode("CGU-RPV-03");
    const ticket = await reportMaintenance(db, { unitId: unit.id, title: "Pompa kolam bocor, ganti seal", notes: "Air kolam turun sekitar 5 cm per hari. Teknisi datang besok pagi.", blockUntil: addDays(T, 3), actor: A(unit).manager, now: past(at(T, "08:00")) });
    if (!ticket.ok) fail(`maintenance.today.${ticket.error}`);
  }
  // Add-ons asked for at checkout: staff confirmed the older ones.
  const requested = await db
    .select({ id: schema.addonOrders.id, createdAt: schema.addonOrders.createdAt, reservationId: schema.addonOrders.reservationId })
    .from(schema.addonOrders)
    .where(eq(schema.addonOrders.status, "requested"));
  const checkoutOrders = requested.filter((o) => plans.some((p) => p.id === o.reservationId && p.addons)).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
  for (const o of checkoutOrders.slice(0, -2)) {
    const plan = plans.find((p) => p.id === o.reservationId)!;
    await confirmAddonOrder(db, { orderId: o.id, actor: A(plan.unit).fo, notify: false, now: new Date(o.createdAt.getTime() + 20 * 3_600_000) });
  }
  // A guest asked to move their stay by a day.
  for (const s of plans.filter((p) => p.fate === "stay" && !p.tag && p.id && p.source === "website" && p.checkIn >= addDays(T, 14)).slice(0, 15)) {
    const asked = await requestDateChangeAsGuest(db, { reservationId: s.id!, checkIn: addDays(s.checkIn, 1), checkOut: addDays(s.checkOut, 1), note: "Our flight moved by one day", now: minutesBefore(240) });
    if (asked.ok) break;
  }

  // ---------------------------------------------------------------- phase 5: owners
  const OWNERS = [
    { fullName: "Hendra Wijaya", email: "demo-owner.hendra@example.com", phone: null, units: ["UBD-RVP-01", "UBD-RVP-02"], feeBp: 2000 },
    { fullName: "Sarah Mitchell", email: "demo-owner.sarah@example.com", phone: "+61491570150", units: ["UBD-CNP-01"], feeBp: 2500 },
    { fullName: "Pieter van Dijk", email: "demo-owner.pieter@example.com", phone: null, units: ["CGU-RPV-01", "CGU-RPV-02"], feeBp: 2200 },
    { fullName: "Yuki Tanaka", email: "demo-owner.yuki@example.com", phone: null, units: ["CGU-FME-01"], feeBp: 2000 },
  ];
  const owned: Array<{ ownerId: string; unit: Unit }> = [];
  for (const o of OWNERS) {
    const first = unitByCode(o.units[0]);
    const made = await createOwner(db, { fullName: o.fullName, email: o.email, phone: o.phone, note: "Pemilik fiktif (data demo)", actor: A(first).manager });
    if (!made.ok || !made.id) {
      fail("owner.create");
      continue;
    }
    for (const code of o.units) {
      const unit = unitByCode(code);
      const assigned = await assignUnit(db, { unitId: unit.id, ownerId: made.id, startDate: START, feeBp: o.feeBp, actor: A(unit).manager });
      if (!assigned.ok) fail(`owner.assign.${assigned.error}`);
      else owned.push({ ownerId: made.id, unit });
    }
  }
  const months: string[] = [];
  for (let m = month(START); m <= month(T); m = addMonths(m, 1)) months.push(m);
  for (const { unit } of owned) {
    await addRecurring(db, { unitId: unit.id, category: "internet", description: "Wi-Fi fiber 100 Mbps", amount: 560_000, startMonth: month(START), actor: A(unit).manager });
    await addRecurring(db, { unitId: unit.id, category: "pool_garden", description: "Perawatan kolam dan taman", amount: 1_250_000, startMonth: month(START), actor: A(unit).manager });
    for (const m of months) {
      const date = m === month(T) ? (addDays(T, -1) < `${m}-20` ? addDays(T, -1) : `${m}-20`) : `${m}-25`;
      if (date < `${m}-01`) continue;
      await addExpense(db, { unitId: unit.id, date, category: "utilities", description: "Listrik PLN", amount: r.int(11, 24) * 100_000, actor: A(unit).manager });
      if (r.chance(0.25)) await addExpense(db, { unitId: unit.id, date: `${m}-12` <= T ? `${m}-12` : date, category: r.pick(["supplies", "repairs", "cleaning"]), description: r.pick(["Ganti handuk dan linen", "Servis AC", "Deep cleaning bulanan", "Ganti lampu taman"]), amount: r.int(4, 18) * 100_000, actor: A(unit).manager });
    }
  }
  // Repairs reported as maintenance tickets, their cost charged to the owner.
  for (const [i, { unit }] of owned.slice(0, 4).entries()) {
    const day = addDays(T, -(30 + i * 47));
    const ticket = await reportMaintenance(db, { unitId: unit.id, title: r.pick(["AC kamar utama tidak dingin", "Pemanas air mati", "Keran wastafel bocor", "Pintu geser macet"]), actor: A(unit).fo, now: at(day, "09:00") });
    if (ticket.ok && ticket.taskId) {
      const done = await finishTask(db, { taskId: ticket.taskId, actor: A(unit).manager, cost: r.int(4, 15) * 100_000, note: "Selesai diperbaiki teknisi", now: at(day, "15:00") });
      if (!done.ok) fail(`maintenance.cost.${done.error}`);
    }
  }
  // Every finished month is locked and paid out.
  const pairs = [...new Map(owned.map((o) => [`${o.ownerId}|${o.unit.propertyId}`, o])).values()];
  for (const m of months.slice(0, -1)) {
    const first = `${m}-01`;
    const lockDay = addDays(nextMonth(first), 4) <= T ? addDays(nextMonth(first), 4) : T;
    for (const { ownerId, unit } of pairs) {
      const locked = await lockStatement(db, { ownerId, propertyId: unit.propertyId, month: m, today: lockDay, actor: A(unit).manager, now: past(at(lockDay, "10:00")) });
      if (!locked.ok) {
        fail(`statement.lock.${locked.error}`);
        continue;
      }
      const [st] = await db
        .select({ id: schema.ownerStatements.id })
        .from(schema.ownerStatements)
        .where(and(eq(schema.ownerStatements.ownerId, ownerId), eq(schema.ownerStatements.propertyId, unit.propertyId), eq(schema.ownerStatements.month, first)));
      const payDay = addDays(lockDay, 5) <= T ? addDays(lockDay, 5) : T;
      if (st) await markStatementPaid(db, { statementId: st.id, reference: `TRF/${m.replace("-", "")}/${ownerId.slice(0, 4).toUpperCase()}`, actor: A(unit).manager, now: past(at(payDay, "14:00")) });
    }
  }

  // ---------------------------------------------------------------- phase 6: guest profiles and report schedules
  const tags = [["vip"], ["honeymoon"], ["family"], ["business"], ["vip", "family"], ["caution"]];
  for (const [i, g] of regulars.entries()) {
    const [row] = await db.select().from(schema.guests).where(eq(schema.guests.email, g.email));
    if (!row) continue;
    const notes = tags[i][0] === "caution" ? "Pernah menyebabkan kerusakan perabot; minta deposit kerusakan saat check-in." : GUEST_NOTES[i % GUEST_NOTES.length];
    await updateGuest(db, { guestId: row.id, fullName: row.fullName, email: row.email, phone: row.phone, countryCode: row.countryCode, notes, tags: tags[i], actor: actors.ubud.manager });
  }
  await addSubscription(db, { propertyId: ubud.id, kind: "daily", staffId: actors.ubud.manager.id, locale: "id", actor: actors.ubud.manager });
  await addSubscription(db, { propertyId: ubud.id, kind: "weekly", email: "demo-akuntan@example.com", locale: "en", actor: actors.ubud.manager });
  await addSubscription(db, { propertyId: canggu.id, kind: "daily", staffId: actors.canggu.manager.id, locale: "id", actor: actors.canggu.manager });
  await addSubscription(db, { propertyId: canggu.id, kind: "monthly", email: "demo-akuntan@example.com", locale: "id", actor: actors.canggu.manager });

  const occupied = await db
    .select({ checkIn: schema.reservations.checkIn, checkOut: schema.reservations.checkOut })
    .from(schema.reservations)
    .where(inArray(schema.reservations.status, ["confirmed", "in_house", "checked_out"]));
  const nights = new Map<string, number>();
  for (const o of occupied) for (let d = o.checkIn; d < o.checkOut; d = addDays(d, 1)) nights.set(month(d), (nights.get(month(d)) ?? 0) + 1);
  const days = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
  console.log("Occupancy:", [...nights.keys()].sort().map((m) => `${m} ${Math.round(((nights.get(m) ?? 0) / (units.length * days(m))) * 100)}%`).join(", "));
  const count = async (status: string) => (await db.select({ id: schema.reservations.id }).from(schema.reservations).where(eq(schema.reservations.status, status as "confirmed"))).length;
  const demoGuests = (await db.select({ id: schema.guests.id }).from(schema.guests).where(like(schema.guests.email, "demo-%@example.com"))).length;
  console.log(
    `Built: ${await count("checked_out")} checked out, ${await count("in_house")} in house, ${await count("confirmed")} upcoming, ${await count("cancelled")} cancelled, ${await count("no_show")} no-shows, ${await count("hold")} holds; ${demoGuests} guests.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
