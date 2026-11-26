import Link from "next/link";
import type { ReactNode } from "react";
import { IssueLinkForm } from "@/components/ops/admin/issue-link-form";
import { Card, dangerButton, inputClass, labelClass, Pill, primaryButton, secondaryButton } from "@/components/ops/ui";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { brand } from "@/config/brand";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import type { Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can, roles } from "@/lib/authz/permissions";
import { resetUserTwoFactorAction, setUserActiveAction, updateUserAction } from "@/lib/ops/admin-actions";
import { allProperties, staffDetail } from "@/lib/ops/users";

/**
 * One staff member: profile (role and properties), account security and
 * history. Directors can change them; branch managers only look. Used by the
 * full page and the detail panel.
 */
export async function UserDetail({
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
  const t = dict.users;
  const sp = await searchParams;
  const data = can(staff.actor, "team.view").allowed ? await staffDetail(staff.actor, id) : null;
  if (!data) return <ErrorNote>{t.errors.not_found}</ErrorNote>;
  const { member: u, activity, changes } = data;
  const properties = await allProperties();
  const canManage = can(staff.actor, "users.manage").allowed;
  const self = u.id === staff.staffId;
  const when = new Intl.DateTimeFormat(lang === "id" ? "id-ID" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: brand.timezone });
  const done = typeof sp.done === "string" ? (t.done as Record<string, string>)[sp.done] : undefined;
  const error = typeof sp.error === "string" ? ((t.errors as Record<string, string>)[sp.error] ?? t.errors.invalid) : undefined;
  const history = t.history as Record<string, string>;
  // Labels the app already has for these log entries; otherwise the code in words.
  const known = { ...(dict.resDetail.activity as Record<string, string>), ...(dict.taskDetail.actions as Record<string, string>), ...history };
  const describe = (action: string) => known[action] ?? action.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase());
  const initials = u.fullName
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const hidden = (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="staffId" value={u.id} />
    </>
  );
  const confirmBox = (
    <label className="flex items-center gap-2 text-sm text-ink">
      <input type="checkbox" name="confirm" value="yes" required className="size-4 accent-danger" />
      {t.confirm}
    </label>
  );

  return (
    <div className="space-y-5">
      {inPanel ? null : (
        <Link href={`/${lang}/ops/users`} className="text-sm text-lagoon hover:underline">
          ← {t.title}
        </Link>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <span aria-hidden className="grid size-14 place-items-center rounded-full bg-lagoon-soft text-lg font-semibold text-lagoon">
          {initials}
        </span>
        <div className="min-w-0">
          <h1 className="font-display text-2xl text-ink">
            {u.fullName}
            {self ? <span className="ml-2 align-middle text-sm font-normal text-stone">({t.you})</span> : null}
          </h1>
          <p className="text-sm text-stone">{u.email}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            <Pill tone={u.role === "director" ? "warn" : "info"}>{dict.ops.roles[u.role]}</Pill>
            {u.isActive ? <Pill tone="good">{t.active}</Pill> : <Pill tone="bad">{t.inactive}</Pill>}
            {u.twoFactorEnabled ? <Pill tone="good">2FA · {t.twoFactorOn}</Pill> : <Pill tone="warn">2FA · {t.twoFactorOff}</Pill>}
          </div>
        </div>
      </div>
      <div className="space-y-2">
        {done ? <SuccessNote>{done}</SuccessNote> : null}
        <ErrorNote>{error}</ErrorNote>
      </div>

      <div className="grid gap-5 @4xl:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          <Card title={t.profile}>
            {canManage ? (
              <form action={updateUserAction} className="space-y-4">
                {hidden}
                <label className={labelClass}>
                  <span>{t.fullName}</span>
                  <input name="fullName" defaultValue={u.fullName} required minLength={2} maxLength={120} className={inputClass} />
                </label>
                <div className={labelClass}>
                  <span>{t.email}</span>
                  <p className="text-sm font-normal text-ink">{u.email}</p>
                  <p className="font-normal">{t.emailFixed}</p>
                </div>
                <label className={labelClass}>
                  <span>{t.roleLabel}</span>
                  <select name="role" defaultValue={u.role} disabled={self} className={inputClass}>
                    {roles.map((r) => (
                      <option key={r} value={r}>
                        {dict.ops.roles[r]}
                      </option>
                    ))}
                  </select>
                  {/* A disabled select is not sent; keep the current role. */}
                  {self ? <input type="hidden" name="role" value={u.role} /> : null}
                </label>
                <fieldset className="space-y-2">
                  <legend className="text-xs font-medium text-stone">{t.propertiesLabel}</legend>
                  <div className="flex flex-wrap gap-3">
                    {properties.map((p) => (
                      <label key={p.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-ink">
                        <input type="checkbox" name="propertyId" value={p.id} defaultChecked={u.propertyIds.includes(p.id)} className="size-4 accent-lagoon" />
                        {p.name}
                      </label>
                    ))}
                  </div>
                  <p className="text-xs text-stone">{t.propertiesHint}</p>
                </fieldset>
                <button type="submit" className={primaryButton}>
                  {t.save}
                </button>
              </form>
            ) : (
              <dl className="grid gap-3 text-sm @md:grid-cols-2">
                <Item label={t.roleLabel} value={dict.ops.roles[u.role]} />
                <Item label={t.propertiesLabel} value={u.role === "director" ? t.allProps : properties.filter((p) => u.propertyIds.includes(p.id)).map((p) => p.name).join(", ") || "—"} />
              </dl>
            )}
          </Card>

          <Card title={t.activity}>
            {activity.length ? (
              <ol className="space-y-2 text-sm">
                {activity.map((a, i) => (
                  <li key={i} className="flex flex-wrap justify-between gap-2 border-b border-line/60 pb-2 last:border-0 last:pb-0">
                    <span className="text-ink">{describe(a.action)}</span>
                    <span className="text-xs text-stone">{when.format(a.occurredAt)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-stone">{t.noActivity}</p>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title={t.security}>
            <dl className="space-y-3 text-sm">
              <Item label={t.twoFactorStatus} value={u.twoFactorEnabled ? t.twoFactorOn : t.twoFactorOff} />
              <Item label={t.columns.lastSeen} value={u.lastSeen ? when.format(new Date(u.lastSeen)) : t.never} />
            </dl>
            <p className="mt-3 text-xs text-stone">{format(t.created, { date: when.format(u.createdAt) })}</p>
            {canManage && !self ? (
              <div className="mt-5 space-y-5 border-t border-line/70 pt-5">
                {u.isActive && u.authUserId ? (
                  <div className="space-y-2">
                    <p className="text-xs text-stone">{t.newLinkHint}</p>
                    <IssueLinkForm lang={lang} staffId={u.id} t={{ newLink: t.newLink, working: t.working, linkReady: t.linkReady, linkEmailed: t.linkEmailed, linkNotEmailed: t.linkNotEmailed, copy: t.copy, copied: t.copied, errors: t.errors as Record<string, string> }} />
                  </div>
                ) : null}
                {u.isActive && u.twoFactorEnabled ? (
                  <form action={resetUserTwoFactorAction} className="space-y-2">
                    {hidden}
                    <p className="text-xs text-stone">{format(t.reset2faHint, { name: u.fullName })}</p>
                    {confirmBox}
                    <button type="submit" className={secondaryButton}>
                      {t.reset2fa}
                    </button>
                  </form>
                ) : null}
                {u.isActive ? (
                  <form action={setUserActiveAction} className="space-y-2">
                    {hidden}
                    <input type="hidden" name="active" value="false" />
                    <p className="text-xs text-stone">{format(t.deactivateHint, { name: u.fullName })}</p>
                    {confirmBox}
                    <button type="submit" className={dangerButton}>
                      {t.deactivate}
                    </button>
                  </form>
                ) : (
                  <form action={setUserActiveAction}>
                    {hidden}
                    <input type="hidden" name="active" value="true" />
                    <button type="submit" className={primaryButton}>
                      {t.reactivate}
                    </button>
                  </form>
                )}
              </div>
            ) : self ? (
              <p className="mt-4 text-xs text-stone">
                <Link href={`/${lang}/ops/security`} className="text-lagoon hover:underline">
                  {dict.ops.security}
                </Link>
              </p>
            ) : null}
          </Card>

          <Card title={t.changes}>
            {changes.length ? (
              <ol className="space-y-2 text-sm">
                {changes.map((c, i) => (
                  <li key={i} className="border-b border-line/60 pb-2 last:border-0 last:pb-0">
                    <span className="block text-ink">{describe(c.action)}</span>
                    <span className="block text-xs text-stone">
                      {when.format(c.occurredAt)}
                      {c.actorName ? ` · ${c.actorName}` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-stone">{t.noActivity}</p>
            )}
          </Card>
        </div>
      </div>
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
