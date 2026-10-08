import crypto from "crypto";
import { razorpayConfig } from "./config";

// Minimal Razorpay REST client (Orders + Refunds) and signature helpers. No SDK: three calls
// do not justify a dependency, and a plain fetch is trivially mockable in tests
// (razorpayHttp.fetch is swapped out there).

const BASE = "https://api.razorpay.com/v1";

export const razorpayHttp: { fetch: typeof fetch } = { fetch: (...a) => fetch(...a) };

export class RazorpayError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (!razorpayConfig.configured()) throw new RazorpayError("Razorpay is not configured", 0, "NOT_CONFIGURED");
  const auth = Buffer.from(`${razorpayConfig.keyId()}:${razorpayConfig.keySecret()}`).toString("base64");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await razorpayHttp.fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Never log or return the request (it carries the basic-auth header's material).
      throw new RazorpayError(json?.error?.description || `Razorpay HTTP ${res.status}`, res.status, json?.error?.code);
    }
    return json as T;
  } catch (err) {
    if (err instanceof RazorpayError) throw err;
    throw new RazorpayError(`Razorpay request failed: ${(err as Error).message}`, 0, "NETWORK");
  } finally {
    clearTimeout(timer);
  }
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

export function createOrder(amountPaise: number, receipt: string, notes: Record<string, string>) {
  return call<RazorpayOrder>("POST", "/orders", {
    amount: amountPaise,
    currency: "INR",
    receipt: receipt.slice(0, 40),
    notes,
    payment_capture: 1,
  });
}

export interface RazorpayRefund {
  id: string;
  amount: number;
  status: string; // pending | processed | failed
}

export function refundPayment(paymentId: string, amountPaise: number, receipt: string) {
  return call<RazorpayRefund>("POST", `/payments/${encodeURIComponent(paymentId)}/refund`, {
    amount: amountPaise,
    speed: "normal",
    receipt: receipt.slice(0, 40),
  });
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Checkout handler signature: HMAC-SHA256(order_id|payment_id, key_secret). UI hint only. */
export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string, secret = razorpayConfig.keySecret()) {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  return safeEqualHex(expected, signature);
}

/** Webhook signature: HMAC-SHA256 of the RAW request body with the webhook secret. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined, secret = razorpayConfig.webhookSecret()) {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqualHex(expected, signature);
}
