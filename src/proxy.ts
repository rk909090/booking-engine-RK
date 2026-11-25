import { NextResponse, type NextRequest } from "next/server";
import { hasLocale, localeCookie } from "@/i18n/config";
import { negotiateLocale } from "@/i18n/negotiate";

/**
 * Sends every page request without a locale prefix to /{locale}/...
 * An explicit choice (cookie) wins over the browser's Accept-Language.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const first = pathname.split("/")[1] ?? "";
  if (hasLocale(first)) return;

  const cookie = request.cookies.get(localeCookie)?.value;
  const locale =
    cookie && hasLocale(cookie) ? cookie : negotiateLocale(request.headers.get("accept-language"));

  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === "/" ? "" : pathname}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Skip Next internals, API routes and any path with a file extension.
  matcher: ["/((?!_next|api|.*\\..*).*)"],
};
