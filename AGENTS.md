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
- Staff auth: Better Auth (`src/lib/auth/config.ts`), email + password with mandatory TOTP 2FA, no public sign-up. Staff are created with `npm run staff:invite`. Pages that read the session call `requireStaff()` inside `<Suspense>`. After sign-in, 2FA or sign-out, navigate with `navigateAfterAuthChange()` (full load), never `router.push`, so a router-cached redirect is not reused.
- Production builds use Webpack (`next build --webpack`): Hostinger's build cannot run Turbopack's CSS worker.
- Before committing: `npm run check` and `npm run build`.
