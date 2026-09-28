/**
 * Fractional indexing for pipeline card order (spec §5.5 "Ordering", §6 "Card move").
 *
 * Vendored from rocicorp/fractional-indexing (https://github.com/rocicorp/fractional-indexing),
 * which is dedicated to the public domain under CC0-1.0, and is itself based on David
 * Greenspan's "Implementing Fractional Indexing" (observablehq.com/@dgreensp/implementing-fractional-indexing).
 * Re-typed for this repo with no dependency; the algorithm is unchanged.
 * ⚠️ Re-check the upstream LICENSE file if this is ever updated from upstream.
 *
 * Key shape: an "integer part" whose first character encodes its length (a–z positive,
 * A–Z negative) followed by base-62 digits, then an optional fractional part that never
 * ends in "0". The digit alphabet is in ASCII order, so a plain code-unit comparison of
 * two keys IS their order — which is exactly Postgres `COLLATE "C"`.
 *
 * ⚠️ ORDER RULES (CI-enforced):
 *   - Compare ranks only with `compareRank` (plain `<` / `>`), never a locale-aware
 *     string comparison — a locale collation sorts "Zz" after "a0" and silently
 *     scrambles the board.
 *   - In SQL, order ranks only with `COLLATE "C"`.
 *   - The column is VarChar(64): a key longer than RANK_MAX_LENGTH must trigger the
 *     locked rebalance (§6) instead of being written.
 */

const BASE_62_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = BASE_62_DIGITS[0];
const SMALLEST_INTEGER = "A" + ZERO.repeat(26);

/** Longest rank the `pipeline_projects.rank` VarChar(64) column accepts. */
export const RANK_MAX_LENGTH = 64;

/** Code-unit order (= Postgres COLLATE "C"). The only comparator ranks may use. */
export function compareRank(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when a generated key is too long for the column and the phase must be rebalanced. */
export function rankNeedsRebalance(key: string): boolean {
  return key.length > RANK_MAX_LENGTH;
}

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`rank midpoint: ${a} >= ${b}`);
  if (a.slice(-1) === ZERO || (b !== null && b.slice(-1) === ZERO)) {
    throw new Error("rank midpoint: trailing zero");
  }
  if (b !== null) {
    // Remove the longest common prefix, padding `a` with zeros as we go. `b` never
    // needs padding: it cannot end before `a` while traversing the common prefix.
    let n = 0;
    while ((a[n] || ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  // The first digits (or the lack of a digit) differ.
  const digitA = a ? BASE_62_DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? BASE_62_DIGITS.indexOf(b[0]) : BASE_62_DIGITS.length;
  if (digitB - digitA > 1) {
    return BASE_62_DIGITS[Math.round(0.5 * (digitA + digitB))];
  }
  // The first digits are consecutive.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  // `b` is null or a single digit: keep a's first digit and recurse on the rest,
  // e.g. midpoint("49", "5") → "4" + midpoint("9", null) → "495".
  return BASE_62_DIGITS[digitA] + midpoint(a.slice(1), null);
}

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - "a".charCodeAt(0) + 2;
  if (head >= "A" && head <= "Z") return "Z".charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error(`invalid rank head: ${head}`);
}

function validateInteger(int: string): void {
  if (int.length !== integerLength(int[0])) throw new Error(`invalid rank integer part: ${int}`);
}

function integerPart(key: string): string {
  const len = integerLength(key[0]);
  if (len > key.length) throw new Error(`invalid rank: ${key}`);
  return key.slice(0, len);
}

function validateKey(key: string): void {
  if (key === SMALLEST_INTEGER) throw new Error(`invalid rank: ${key}`);
  const i = integerPart(key); // throws on a bad head or a too-short key
  const f = key.slice(i.length);
  if (f.slice(-1) === ZERO) throw new Error(`invalid rank: ${key}`);
  // Ranks are read back from the database, so reject any character outside the
  // alphabet rather than let indexOf() return -1 inside midpoint().
  for (let k = 1; k < key.length; k++) {
    if (BASE_62_DIGITS.indexOf(key[k]) < 0) throw new Error(`invalid rank digit in: ${key}`);
  }
}

/** Returns null past the largest integer. */
function incrementInteger(x: string): string | null {
  validateInteger(x);
  const head = x[0];
  const digs = x.slice(1).split("");
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = BASE_62_DIGITS.indexOf(digs[i]) + 1;
    if (d === BASE_62_DIGITS.length) {
      digs[i] = ZERO;
    } else {
      digs[i] = BASE_62_DIGITS[d];
      carry = false;
    }
  }
  if (!carry) return head + digs.join("");
  if (head === "Z") return "a" + ZERO;
  if (head === "z") return null;
  const h = String.fromCharCode(head.charCodeAt(0) + 1);
  if (h > "a") digs.push(ZERO);
  else digs.pop();
  return h + digs.join("");
}

/** Returns null past the smallest integer. */
function decrementInteger(x: string): string | null {
  validateInteger(x);
  const head = x[0];
  const digs = x.slice(1).split("");
  const top = BASE_62_DIGITS[BASE_62_DIGITS.length - 1];
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = BASE_62_DIGITS.indexOf(digs[i]) - 1;
    if (d === -1) {
      digs[i] = top;
    } else {
      digs[i] = BASE_62_DIGITS[d];
      borrow = false;
    }
  }
  if (!borrow) return head + digs.join("");
  if (head === "a") return "Z" + top;
  if (head === "A") return null;
  const h = String.fromCharCode(head.charCodeAt(0) - 1);
  if (h < "Z") digs.push(top);
  else digs.pop();
  return h + digs.join("");
}

/**
 * A key strictly between `a` and `b` (either may be null for "no bound").
 * `keyBetween(null, first)` puts a card at the top of a phase; `keyBetween(last, null)`
 * at the bottom. Throws when `a >= b` or either key is malformed.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) validateKey(a);
  if (b !== null) validateKey(b);
  if (a !== null && b !== null && a >= b) throw new Error(`rank: ${a} >= ${b}`);
  if (a === null) {
    if (b === null) return "a" + ZERO;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint("", fb);
    if (ib < b) return ib;
    const res = decrementInteger(ib);
    if (res === null) throw new Error("rank: cannot decrement any more");
    return res;
  }
  if (b === null) {
    const ia = integerPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia);
    return i === null ? ia + midpoint(fa, null) : i;
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const i = incrementInteger(ia);
  if (i === null) throw new Error("rank: cannot increment any more");
  if (i < b) return i;
  return ia + midpoint(fa, null);
}

/** `n` ordered keys strictly between `a` and `b` (used by the locked rebalance, §6). */
export function nKeysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  if (b === null) {
    let c = keyBetween(a, b);
    const out = [c];
    for (let i = 0; i < n - 1; i++) {
      c = keyBetween(c, b);
      out.push(c);
    }
    return out;
  }
  if (a === null) {
    let c = keyBetween(a, b);
    const out = [c];
    for (let i = 0; i < n - 1; i++) {
      c = keyBetween(a, c);
      out.push(c);
    }
    out.reverse();
    return out;
  }
  const mid = Math.floor(n / 2);
  const c = keyBetween(a, b);
  return [...nKeysBetween(a, c, mid), c, ...nKeysBetween(c, b, n - mid - 1)];
}
