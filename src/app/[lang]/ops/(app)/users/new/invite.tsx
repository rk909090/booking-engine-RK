import { InviteForm } from "@/components/ops/admin/invite-form";
import { ErrorNote } from "@/components/ui";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can, roles } from "@/lib/authz/permissions";
import { allProperties } from "@/lib/ops/users";

/** The invitation form (page and panel). */
export async function Invite({ lang, dict }: { lang: Locale; dict: Dictionary }) {
  const staff = await requireStaff(lang);
  const t = dict.users;
  if (!can(staff.actor, "users.manage").allowed) return <ErrorNote>{t.errors.role}</ErrorNote>;
  const properties = await allProperties();
  return (
    <div className="space-y-4">
      <p className="text-sm text-stone">{t.inviteForm.intro}</p>
      <InviteForm
        lang={lang}
        roles={roles.map((r) => ({ value: r, label: dict.ops.roles[r] }))}
        properties={properties.map((p) => ({ slug: p.slug, name: p.name }))}
        t={{
          fullName: t.fullName,
          email: t.email,
          roleLabel: t.roleLabel,
          propertiesLabel: t.propertiesLabel,
          propertiesHint: t.propertiesHint,
          submit: t.inviteForm.submit,
          working: t.working,
          done: t.inviteForm.done,
          openProfile: t.inviteForm.openProfile,
          another: t.inviteForm.another,
          linkReady: t.linkReady,
          linkEmailed: t.linkEmailed,
          linkNotEmailed: t.linkNotEmailed,
          copy: t.copy,
          copied: t.copied,
          errors: t.errors as Record<string, string>,
        }}
      />
    </div>
  );
}
