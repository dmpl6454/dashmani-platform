import dotenv from "dotenv";
import path from "path";

const envPaths = [
  path.resolve(process.cwd(), "apps/api/.env"),
  path.resolve(__dirname, "../.env"),
];

for (const p of envPaths) {
  const r = dotenv.config({ path: p });
  if (!r.error && r.parsed) {
    console.log(`◇ Loaded ${Object.keys(r.parsed).length} env vars from ${p}`);
    break;
  }
}

// ⚠️ Several modules fall back to the public string "dev-secret" when JWT_SECRET is
// unset (utils/jwt.ts, client-auth, campaign media URLs). In production that would let
// anyone forge an access token for any portal, so a production process without a real
// JWT_SECRET refuses to start (security audit 2026-10-28). Refresh tokens are also
// checked against their stored hash, so a missing JWT_REFRESH_SECRET is only warned about.
if (process.env.NODE_ENV === "production") {
  const secret = process.env.JWT_SECRET ?? "";
  if (!secret || secret === "dev-secret" || secret === "change-me-in-production") {
    console.error("FATAL: JWT_SECRET is missing or a placeholder in production — refusing to start.");
    process.exit(1);
  }
  if (!process.env.JWT_REFRESH_SECRET) {
    console.error("WARNING: JWT_REFRESH_SECRET is not set; refresh tokens are signed with a public fallback.");
  }
}
