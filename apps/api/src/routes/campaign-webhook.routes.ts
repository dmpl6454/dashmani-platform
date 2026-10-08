import express, { Router, Request, Response, NextFunction } from "express";
import { AppError } from "../middleware/error-handler";
import { handleWebhook } from "../services/campaign/payment.service";

// Razorpay webhook. ⚠️ Mounted in app.ts BEFORE the global JSON parser: the signature is an
// HMAC of the exact raw bytes, and a re-serialised JSON body would never verify.
//
// Responses: 2xx means "received" (Razorpay stops retrying); a bad signature is 400. Any other
// failure is a 500 so Razorpay redelivers — processing is idempotent on the event id.

const router = Router();

router.post(
  "/",
  express.raw({ type: () => true, limit: "1mb" }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result = await handleWebhook(
        raw,
        req.header("x-razorpay-signature") ?? undefined,
        req.header("x-razorpay-event-id") ?? undefined,
      );
      return res.json({ success: true, data: result });
    } catch (err) {
      if (err instanceof AppError && err.statusCode < 500) {
        return res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
      }
      console.error("[razorpay-webhook] processing failed:", err);
      return next(err);
    }
  },
);

export default router;
