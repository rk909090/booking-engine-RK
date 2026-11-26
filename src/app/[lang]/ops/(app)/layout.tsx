import { notFound } from "next/navigation";
import { Suspense } from "react";
import { NavTrail } from "@/components/ops/shell/side-panel";
import { Sidebar, SidebarSkeleton } from "@/components/ops/shell/sidebar";
import { hasLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/get-dictionary";

/**
 * Frame of the staff working area: the menu on the left, the page using the
 * full width, and the detail panel (the @panel slot) on the right when a
 * reservation, guest, task or user is opened from a list.
 * Sign-in, account security and print pages live outside this group.
 */
export default async function OpsAppLayout({ children, panel, params }: LayoutProps<"/[lang]/ops">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <div className="min-h-dvh bg-canvas lg:flex">
      <Suspense fallback={<SidebarSkeleton />}>
        <Sidebar lang={lang} dict={dict} />
      </Suspense>
      <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        {children}
      </main>
      {panel}
      <Suspense fallback={null}>
        <NavTrail />
      </Suspense>
    </div>
  );
}
