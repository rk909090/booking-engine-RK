import { getAuth } from "@/lib/auth/server";

// Better Auth serves every /api/auth/* endpoint (sign-in, 2FA, password reset).
export function GET(request: Request) {
  return getAuth().handler(request);
}

export function POST(request: Request) {
  return getAuth().handler(request);
}
