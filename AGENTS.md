<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project notes

- Product plan and decisions: `docs/02-PLAN-PENGEMBANGAN.md`. Reference demo analysis: `docs/01-ANALISIS-DEMO-SAVARA.md`.
- Single brand, multi-property. Brand identity lives in `src/config/brand.ts`, never hard-coded in components.
- Routes live under `src/app/[lang]` (`id`, `en`). `src/proxy.ts` redirects unprefixed paths. Every user-facing string goes in `src/i18n/dictionaries/*.json`; `npm run check:i18n` enforces identical keys.
- Database: Postgres (Supabase) via Drizzle. Schema in `src/db/schema.ts`; migrations in `drizzle/` (generate with `npm run db:generate`). The double-booking guard is the EXCLUDE constraint in `drizzle/0001_reservation_overlap_guard.sql`; keep it in sync with `OCCUPYING_STATUSES`.
- Authorization: call `authorize()` from `src/lib/authz/permissions.ts` on the server for every action. Hiding UI is not a security boundary.
- Permissions: the matrix in `permissions.ts` holds the defaults; directors change them per role on `/ops/roles` (stored as overrides in `role_permissions`, loaded into `actor.permissions`). Directors hold every permission (locked); other cells in `isLocked()` never change either. A new action must also be added to `src/lib/authz/action-groups.ts` and to `rbac.actions` in the dictionaries (a test checks the groups).
- Staff area layout: pages under `src/app/[lang]/ops/(app)` share the sidebar layout and the `@panel` slot; sign-in, account security and print pages are in `(standalone)`. Reservation, guest, task and user details open in the right-hand panel through intercepting routes (`@panel/(.)…`) and render the same component as their full page. Do not add a catch-all page to `@panel` (it makes every URL match the group and breaks strict route matching). A detail route `x/[id]` intercepts every `x/<anything>`, so static pages must not sit next to it (hence `/ops/new-booking` and `/ops/immigration`).
- Demo data: `npm run demo:seed` / `npm run demo:clear` (`scripts/demo/`). Clear it before launch.
- Staff auth: Better Auth (`src/lib/auth/config.ts`), email + password with mandatory TOTP 2FA, no public sign-up. Staff are created with `npm run staff:invite`. Pages that read the session call `requireStaff()` inside `<Suspense>`. After sign-in, 2FA or sign-out, navigate with `navigateAfterAuthChange()` (full load), never `router.push`, so a router-cached redirect is not reused.
- Production builds use Webpack (`next build --webpack`): Hostinger's build cannot run Turbopack's CSS worker.
- Before committing: `npm run check` and `npm run build`.
