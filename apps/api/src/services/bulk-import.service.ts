import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";
import * as XLSX from "xlsx";
import fs from "fs";

interface AccountRow {
  handle: string;
  displayName: string;
  platform: string;
  clientName?: string;
  profileUrl?: string;
  followerCount?: number;
}

export async function importAccountsFromExcel(filePath: string) {
  if (!fs.existsSync(filePath)) {
    throw new AppError(400, "FILE_NOT_FOUND", "Upload file not found");
  }

  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new AppError(400, "EMPTY_FILE", "Excel file has no sheets");
  }

  const rows: any[] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
  if (rows.length === 0) {
    throw new AppError(400, "NO_DATA", "Excel file has no data rows");
  }

  // Get all platforms
  const platforms = await prisma.platform.findMany();
  const platformMap = new Map(platforms.map((p) => [p.slug.toLowerCase(), p.id]));
  const platformNameMap = new Map(platforms.map((p) => [p.name.toLowerCase(), p.id]));

  const results = {
    total: rows.length,
    created: 0,
    skipped: 0,
    errors: [] as { row: number; handle: string; error: string }[],
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // Excel rows start at 1, header is row 1

    const handle = (row.handle || row.Handle || row.username || row.Username || "").toString().trim();
    const displayName = (row.displayName || row.display_name || row.DisplayName || row.name || row.Name || handle).toString().trim();
    const platformStr = (row.platform || row.Platform || "").toString().trim().toLowerCase();
    const clientName = (row.clientName || row.client_name || row.ClientName || row.client || row.Client || "").toString().trim() || null;
    const profileUrl = (row.profileUrl || row.profile_url || row.ProfileUrl || row.url || row.URL || "").toString().trim() || null;
    const followerCount = parseInt(row.followerCount || row.follower_count || row.FollowerCount || row.followers || "0") || 0;

    if (!handle) {
      results.errors.push({ row: rowNum, handle: "", error: "Missing handle" });
      results.skipped++;
      continue;
    }

    // Find platform ID
    let platformId = platformMap.get(platformStr) || platformNameMap.get(platformStr);
    if (!platformId) {
      results.errors.push({ row: rowNum, handle, error: `Unknown platform: ${platformStr}` });
      results.skipped++;
      continue;
    }

    try {
      // Check if account already exists
      const existing = await prisma.socialAccount.findUnique({
        where: { handle_platformId: { handle, platformId } },
      });

      if (existing) {
        // Update existing account
        await prisma.socialAccount.update({
          where: { id: existing.id },
          data: { displayName, clientName, profileUrl, followerCount },
        });
        results.skipped++;
      } else {
        await prisma.socialAccount.create({
          data: { handle, displayName, platformId, clientName, profileUrl, followerCount },
        });
        results.created++;
      }
    } catch (err: any) {
      results.errors.push({ row: rowNum, handle, error: err.message });
      results.skipped++;
    }
  }

  // Clean up uploaded file
  try { fs.unlinkSync(filePath); } catch {}

  return results;
}

export function getImportTemplate() {
  const ws = XLSX.utils.aoa_to_sheet([
    ["handle", "displayName", "platform", "clientName", "profileUrl", "followerCount"],
    ["@example", "Example Account", "instagram", "Client Name", "https://instagram.com/example", 1000],
    ["example_page", "Example Page", "facebook", "Client Name", "https://facebook.com/example_page", 5000],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Accounts");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
