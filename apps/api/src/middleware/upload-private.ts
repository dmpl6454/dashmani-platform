import { createHash } from "crypto";
import type { RequestHandler } from "express";
import multer from "multer";
import { AppError } from "./error-handler";

// Private, memory-only uploads (spec-00 §2.4) for files the server reads and never keeps: a Swipe
// export, a bank statement. Bytes stay in req.file.buffer for the request and are never written to
// disk. ⚠️ Never import ./upload here — it mkdirs the PUBLIC uploads/ folders at load, and
// uploads/ is served to the internet. One file per request, under the field name "file".

export interface MemoryUploadOptions {
  /** Largest file accepted, in bytes. */
  maxBytes: number;
  /** Extension allow-list on the original file name, e.g. /\.(csv|xlsx|xls)$/i. */
  accept: RegExp;
  /** A refusal with its own sentence, checked before `accept` (e.g. bank: .pdf → 415 STATEMENT_PDF). */
  refuse?: (originalName: string) => AppError | null;
  /** Sent when the name passes no `accept`. */
  wrongType: AppError;
  /** Sent when the file is larger than maxBytes — each feature words its own (no portal-wide override). */
  tooLarge: AppError;
  /** Non-file form fields allowed (default 8). */
  fields?: number;
}

export function memoryUpload(o: MemoryUploadOptions): RequestHandler {
  const single = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: o.maxBytes, files: 1, fields: o.fields ?? 8, fieldSize: 64 * 1024 },
    fileFilter: (_req, file, cb) => {
      const refused = o.refuse?.(file.originalname) ?? null;
      if (refused) return cb(refused);
      if (!o.accept.test(file.originalname)) return cb(o.wrongType);
      cb(null, true);
    },
  }).single("file");
  return (req, res, next) => {
    single(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof AppError) return next(err);
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") return next(o.tooLarge);
        return next(new AppError(400, "INVALID_UPLOAD", err.message));
      }
      return next(err);
    });
  };
}

/** SHA-256 of an uploaded file, hex — how a statement or Swipe file is identified without storing it. */
export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// smart-invoicing: import (PR 3)
