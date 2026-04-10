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
