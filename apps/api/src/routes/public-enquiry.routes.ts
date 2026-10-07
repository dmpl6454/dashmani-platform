import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { siteEnquirySchema, type SiteEnquiryInput } from "@dashmani/shared";
import { validate } from "../middleware/validate";
import { success, error } from "../utils/response";
import { submitSiteEnquiry } from "../services/site-enquiry.service";

const router = Router();

// req.ip is the Cloudflare edge IP (see middleware/rate-limit-key.ts), so key on
// (edge ip, email) like the login limiter: one enquirer cannot flood the inbox, and
// unrelated visitors behind the same edge keep their own budget.
const enquiryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 200) : "";
    return `enquiry:${req.ip ?? "unknown"}:${email}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMIT", message: "Too many enquiries, please try again later" } },
});

// POST /public/enquiries — campaign enquiry from digitalsukoon.com (no auth)
router.post(
  "/public/enquiries",
  enquiryLimiter,
  validate(siteEnquirySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = req.body as SiteEnquiryInput;
      // Honeypot filled → a bot. Answer as if accepted so it learns nothing.
      if (input.website) return success(res, { received: true }, undefined, 201);
      const sent = await submitSiteEnquiry(input);
      if (!sent) {
        return error(res, "ENQUIRY_NOT_SENT", "We couldn't send your enquiry right now. Please email hello@digitalsukoon.com.", 503);
      }
      return success(res, { received: true }, undefined, 201);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
