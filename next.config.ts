import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Production builds use Webpack (`next build --webpack`): Hostinger's build
  // environment cannot start the separate Node process Turbopack uses for
  // PostCSS/Tailwind. Local `next dev` still uses Turbopack.
};

export default nextConfig;
