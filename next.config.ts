import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    // Hostinger's build machine reports many CPUs but limits the threads one
    // user may start: with the default (one worker per CPU, 63 there) the page
    // data step fails with "can't spawn worker thread". Four is enough.
    cpus: 4,
  },
  // Production builds use Webpack (`next build --webpack`): Hostinger's build
  // environment cannot start the separate Node process Turbopack uses for
  // PostCSS/Tailwind. Local `next dev` still uses Turbopack.
};

export default nextConfig;
