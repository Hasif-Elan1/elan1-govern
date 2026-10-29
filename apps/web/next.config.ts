import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@gate/core", "@gate/db"],
  serverExternalPackages: ["argon2", "@prisma/client", ".prisma/client"],
  // Security headers that do not depend on the request. CSP (with a nonce) is set in middleware.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ],
      },
      // the console's built files (copied into public/ by scripts/console-assets.mjs): content-hashed, so cached for good
      { source: "/assets/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      // the service worker and its asset list are always checked again, so a new build reaches every browser
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
      { source: "/sw-assets.json", headers: [{ key: "Cache-Control", value: "no-cache" }] },
    ];
  },
};

export default config;
