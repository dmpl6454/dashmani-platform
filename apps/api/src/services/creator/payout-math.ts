/**
 * What a creator is paid for one post. PURE: no database, no Razorpay, no clock.
 *
 * ⚠️ THE ONE PLACE this arithmetic lives. The rate-card screen (the payout floor), checkout (which freezes
 * the figures onto the booking) and the capture (which writes the payout row) all call computePayout, so the
 * number staff were shown, the number frozen at checkout and the number paid out can never be three
 * different roundings of the same thing.
 *
 *   gross  = floor(price × share)        what the creator's share is, before tax
 *   tds    = floor(gross × tds)          tax deducted at source on that share
 *   amount = gross − tds                 what is sent to the creator's linked account
 *
 * Everything is in integer paise, and every division rounds DOWN, so a rounding remainder always stays with
 * us and never with the creator's side: amount ≤ gross ≤ price holds for every input (the creator_payouts
 * CHECK constraint states the same inequality, and the capture refuses a row that would violate it).
 *
 * Integer division is done as (a − a mod b) / b: that is exact for any a below 2^53, whereas floor(a / b)
 * goes through a floating-point quotient. Prices are at most ₹10 lakh and a share at most 10,000 basis
 * points, so the product is at most 1e12, far below 2^53.
 */

const BPS = 10_000;

export interface PayoutAmounts {
  /** The creator's share of the price, before tax. */
  grossPaise: number;
  /** Tax deducted at source from that share. */
  tdsPaise: number;
  /** What is actually sent: gross − tds. */
  amountPaise: number;
}

/** floor(a / b) for a non-negative integer a and a positive integer b, with no floating-point quotient. */
function floorDiv(a: number, b: number): number {
  return (a - (a % b)) / b;
}

/**
 * @param itemPricePaise what the brand pays for this one post (base price plus any song add-on), a non-negative integer
 * @param shareBps       the creator's share, in basis points: 0..10000 (staff may set at most 9000; see CREATOR_SHARE_MAX_BPS)
 * @param tdsBps         tax deducted at source on that share, in basis points: 0..10000 (default 0)
 * @throws RangeError for anything that is not an integer in range. A wrong number here is wrong MONEY, so it
 *         fails loudly instead of being clamped.
 */
export function computePayout(itemPricePaise: number, shareBps: number, tdsBps = 0): PayoutAmounts {
  if (!Number.isSafeInteger(itemPricePaise) || itemPricePaise < 0) throw new RangeError("The price must be a non-negative whole number of paise.");
  if (!Number.isSafeInteger(shareBps) || shareBps < 0 || shareBps > BPS) throw new RangeError("The share must be a whole number of basis points from 0 to 10000.");
  if (!Number.isSafeInteger(tdsBps) || tdsBps < 0 || tdsBps > BPS) throw new RangeError("The TDS rate must be a whole number of basis points from 0 to 10000.");
  const grossPaise = floorDiv(itemPricePaise * shareBps, BPS);
  const tdsPaise = floorDiv(grossPaise * tdsBps, BPS);
  return { grossPaise, tdsPaise, amountPaise: grossPaise - tdsPaise };
}

/**
 * Whether three figures satisfy the rules the creator_payouts table enforces (and the plan states):
 * all non-negative, amount ≤ gross ≤ item price, and amount + tds = gross. Used before a row is written, so
 * a bad frozen figure becomes a refund-due item and an alert rather than a constraint violation that would
 * abort the whole capture.
 */
export function payoutAmountsAreValid(a: { itemPricePaise: number; grossPaise: number; tdsPaise: number; amountPaise: number }): boolean {
  const ints = [a.itemPricePaise, a.grossPaise, a.tdsPaise, a.amountPaise];
  if (!ints.every((n) => Number.isSafeInteger(n) && n >= 0)) return false;
  return a.amountPaise <= a.grossPaise && a.grossPaise <= a.itemPricePaise && a.amountPaise + a.tdsPaise === a.grossPaise;
}
