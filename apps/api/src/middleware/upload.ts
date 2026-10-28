import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { AppError } from "./error-handler";

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");

// Ensure upload directories exist
const dirs = ["documents", "profile-pictures", "imports"];
for (const dir of dirs) {
  const fullPath = path.join(UPLOAD_DIR, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
}

/**
 * Extension written to disk for each accepted MIME type.
 *
 * ⚠️ The stored extension must NEVER come from the uploader's file name alone.
 * `/uploads` is served by express.static, which picks the Content-Type from the
 * extension, and the file filters below only see the client-chosen `mimetype`.
 * Keeping `path.extname(originalname)` let an anonymous job applicant send
 * `x.html` labelled `application/pdf` and have the API serve it back as a web
 * page on api.digitalsukoon.com (stored XSS / phishing on our own domain).
 */
const EXT_BY_MIME: Record<string, string[]> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "application/pdf": [".pdf"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  // Windows browsers label .csv files application/vnd.ms-excel, so both spellings
  // keep the name the user gave the file.
  "application/vnd.ms-excel": [".xls", ".csv"],
  "text/csv": [".csv"],
};

/** The extension to store for an accepted upload — never anything outside EXT_BY_MIME. */
export function safeUploadExtension(mimetype: string, originalname: string): string {
  const allowed = EXT_BY_MIME[mimetype];
  if (!allowed) return "";
  const own = path.extname(originalname || "").toLowerCase();
  return allowed.includes(own) ? own : allowed[0];
}

function makeStorage(subDir: string) {
  return multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, path.join(UPLOAD_DIR, subDir));
    },
    filename: (_req, file, cb) => {
      const uniqueSuffix = crypto.randomBytes(8).toString("hex");
      const ext = safeUploadExtension(file.mimetype, file.originalname);
      cb(null, `${Date.now()}-${uniqueSuffix}${ext}`);
    },
  });
}

export const uploadDocument = multer({
  storage: makeStorage("documents"),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "image/jpeg", "image/png", "image/webp",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError(400, "INVALID_FILE_TYPE", "Only images, PDFs and documents are allowed"));
    }
  },
});

export const uploadProfilePicture = multer({
  storage: makeStorage("profile-pictures"),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError(400, "INVALID_FILE_TYPE", "Only JPEG, PNG or WebP images are allowed"));
    }
  },
});

export const uploadExcel = multer({
  storage: makeStorage("imports"),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/csv",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError(400, "INVALID_FILE_TYPE", "Only Excel (.xlsx, .xls) or CSV files are allowed"));
    }
  },
});

export const UPLOAD_DIR_PATH = UPLOAD_DIR;

/** Convert absolute file path to a URL path relative to the API (e.g. /uploads/profile-pictures/file.png) */
export function toUploadUrl(absolutePath: string): string {
  // Normalize Windows backslashes to forward slashes — URLs use forward slashes only
  const normalized = absolutePath.replace(/\\/g, "/");
  const idx = normalized.indexOf("/uploads/");
  if (idx !== -1) return normalized.slice(idx);
  // fallback: extract from UPLOAD_DIR
  const relative = path.relative(UPLOAD_DIR, absolutePath).replace(/\\/g, "/");
  return `/uploads/${relative}`;
}
