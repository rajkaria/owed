import type { NextConfig } from "next";

// Security headers (W2-E, proposed for LEAD). Pages only load Owed's own scripts, styles, fonts
// (next/font self-hosts them) and data (/api/v1/status polling); QR codes are inline SVG. Wallet
// buttons are solana: links, which a CSP doesn't restrict. Next.js inlines its bootstrap scripts, and
// a nonce would force every page (the landing included) to render per request, so scripts allow
// 'unsafe-inline' but no other origin. Preview deployments also allow Vercel's toolbar (vercel.live).
// API routes, QR images and the x402 endpoint answer JSON, PNG or SVG: they get default-src 'none'.

const isDev = process.env.NODE_ENV === "development";
const isPreview = process.env.VERCEL_ENV === "preview";
const toolbar = (...sources: string[]) => (isPreview ? sources : []);

const pageCsp = [
  `default-src 'self'`,
  `script-src ${["'self'", "'unsafe-inline'", ...(isDev ? ["'unsafe-eval'"] : []), ...toolbar("https://vercel.live")].join(" ")}`,
  `style-src ${["'self'", "'unsafe-inline'", ...toolbar("https://vercel.live")].join(" ")}`,
  `img-src ${["'self'", "data:", "blob:", ...toolbar("https://vercel.live", "https://vercel.com")].join(" ")}`,
  `font-src ${["'self'", ...toolbar("https://vercel.live", "https://assets.vercel.com")].join(" ")}`,
  `media-src 'self'`, // the landing's golden-path recording lives in web/public/media
  `connect-src ${["'self'", ...(isDev ? ["ws:"] : []), ...toolbar("https://vercel.live", "wss://ws-us3.pusher.com")].join(" ")}`,
  `frame-src ${isPreview ? "https://vercel.live" : "'none'"}`,
  `object-src 'none'`,
  `base-uri 'self'`,
  `form-action 'self'`,
  `frame-ancestors 'none'`,
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const apiCsp = "default-src 'none'; frame-ancestors 'none'";

const common = [
  { key: "Content-Security-Policy", value: pageCsp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // Request ids are the only key to a request: other sites see Owed's origin, never the /r/<id> path.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  poweredByHeader: false,
  // SP2: /api/mcp spawns the committed plugin bundle by path (lib/mcp/bundle.ts), which tracing can't see; ship it
  // and its meta file with that function.
  outputFileTracingIncludes: {
    "/api/mcp": ["./mcp/owed-plugin.mjs", "./mcp/owed-plugin.meta.json"],
  },
  async headers() {
    return [
      { source: "/:path*", headers: common },
      // Later entries override the same key: data endpoints get the strict policy.
      { source: "/api/:path*", headers: [{ key: "Content-Security-Policy", value: apiCsp }] },
      { source: "/x/:path*", headers: [{ key: "Content-Security-Policy", value: apiCsp }] },
    ];
  },
};

export default nextConfig;
