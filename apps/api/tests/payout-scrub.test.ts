import { describe, it, expect } from "vitest";
import { REDACTED, destinationHint, lastFour, scrubPayoutObject, scrubPayoutSecrets } from "../src/utils/payout-scrub";

// The scrubber is the last line of defence for creators' PAN, IFSC and bank account numbers: it
// runs over every Razorpay error message, `last_error` column and logged payload. These pin what
// it masks, what it deliberately leaves, and that it cannot be made slow.

describe("scrubPayoutSecrets: masking", () => {
  it.each([
    ["a 5-digit number (the shortest Razorpay accepts)", "account 12345 rejected", "account [redacted] rejected"],
    ["a 12-digit account number", "no such account 123456789012 here", "no such account [redacted] here"],
    ["a 20-digit account number (the longest)", "acct=12345678901234567890.", "acct=[redacted]."],
    ["a run longer than 20 digits, masked whole rather than left half visible", "n=123456789012345678901234567890!", "n=[redacted]!"],
    ["an account number typed in groups of four", "bad 1234 5678 9012 3456 account", "bad [redacted] account"],
    ["an account number typed with hyphens", "bad 1234-5678-9012 account", "bad [redacted] account"],
    ["a PAN", "PAN ABCPE1234F is invalid", "PAN [redacted] is invalid"],
    ["a lower-case PAN", "pan abcpe1234f is invalid", "pan [redacted] is invalid"],
    ["an IFSC, whole, not just its numeric tail", "Invalid IFSC Code HDFC0000317.", "Invalid IFSC Code [redacted]."],
    ["a lower-case IFSC", "ifsc hdfc0000317", "ifsc [redacted]"],
    ["all three in one message", "HDFC0000317 / 1234567890123456 / ABCPE1234F", "[redacted] / [redacted] / [redacted]"],
  ])("masks %s", (_name, input, expected) => {
    expect(scrubPayoutSecrets(input)).toBe(expected);
  });

  it("leaves ordinary sentences and short numbers alone", () => {
    const msgs = [
      "The amount must be at least INR 1.00",
      "transfers.0.amount must be at least 100.",
      "The account number must be between 5 and 20 characters.",
      "Linked account does not exist",
      "Razorpay HTTP 502",
      "Merchant activation form has been locked for editing by admin.",
      "Refund of 4 items failed (attempt 3 of 5)",
    ];
    for (const m of msgs) expect(scrubPayoutSecrets(m)).toBe(m);
  });

  it("documents its trade-off: any 5+ digit figure in a STRING is masked, money included", () => {
    // ₹100 in paise is 10000. Callers keep amounts in structured fields, not inside scrubbed text.
    expect(scrubPayoutSecrets("refund of 10000 paise failed")).toBe("refund of [redacted] paise failed");
    expect(scrubPayoutSecrets("refund of 9999 paise failed")).toBe("refund of 9999 paise failed");
    // Four-digit Indian-style grouped amounts keep their groups short and survive.
    expect(scrubPayoutSecrets("fee 1,00,000")).toBe("fee 1,00,000");
  });

  it("does not join digits across a comma, a colon or a letter", () => {
    expect(scrubPayoutSecrets("1234,5678,9012")).toBe("1234,5678,9012");
    expect(scrubPayoutSecrets("12:34:56")).toBe("12:34:56");
    expect(scrubPayoutSecrets("ab1234cd5678")).toBe("ab1234cd5678");
  });

  it("only joins digit groups across ONE separator", () => {
    expect(scrubPayoutSecrets("12  345")).toBe("12  345"); // two spaces: two separate runs of 2 and 3
    expect(scrubPayoutSecrets("12 345")).toBe("[redacted]"); // one space: 5 digits in total
  });

  it("is idempotent", () => {
    const samples = [
      "HDFC0000317 1234 5678 9012 3456 ABCPE1234F",
      "plain text",
      "x 12345 y 1 2 3 4 5 z",
      "[redacted] 123456",
      "ABCDE1234FGHIJ0123456789",
    ];
    for (const s of samples) {
      const once = scrubPayoutSecrets(s);
      expect(scrubPayoutSecrets(once)).toBe(once);
    }
  });

  it("is idempotent on random mixed input (seeded)", () => {
    let seed = 0x2f6e2b1;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const alphabet = "0123456789 -ABCDEFabcdef0,:._[]redacted";
    for (let n = 0; n < 300; n++) {
      let s = "";
      const len = 1 + Math.floor(rnd() * 60);
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      const once = scrubPayoutSecrets(s);
      expect(scrubPayoutSecrets(once)).toBe(once);
    }
  });

  it("handles empty and non-string input without throwing", () => {
    expect(scrubPayoutSecrets("")).toBe("");
    expect(scrubPayoutSecrets(undefined as unknown as string)).toBe("");
    expect(scrubPayoutSecrets(null as unknown as string)).toBe("");
  });
});

describe("scrubPayoutSecrets: linear time", () => {
  // 200 KB of the shapes most likely to make a naive regex backtrack. A linear scan finishes in
  // milliseconds; the bound is generous so a slow CI box cannot flake it, yet a quadratic scan
  // (200,000 squared = 4e10 steps) would miss it by orders of magnitude.
  const SIZE = 200_000;
  const hostile: Array<[string, string]> = [
    ["digits only", "1".repeat(SIZE)],
    ["digits joined by single spaces", "1 ".repeat(SIZE / 2)],
    ["short digit groups split by commas, never five in a row", "12,34,".repeat(SIZE / 6)],
    ["letters only", "A".repeat(SIZE)],
    ["PAN-like prefixes that never complete", "ABCDE123".repeat(SIZE / 8)],
    ["IFSC-like tokens back to back", "HDFC0abc".repeat(SIZE / 8)],
    ["alternating letters and digits", "a1".repeat(SIZE / 2)],
    ["one separator after another", "- ".repeat(SIZE / 2)],
  ];

  it.each(hostile)("scrubs 200 KB of %s quickly", (_name, input) => {
    const t0 = performance.now();
    const out = scrubPayoutSecrets(input);
    const ms = performance.now() - t0;
    expect(typeof out).toBe("string");
    expect(ms).toBeLessThan(500);
  });

  it("costs about ten times more for ten times the input, not a hundred", () => {
    const time = (s: string) => {
      const t0 = performance.now();
      scrubPayoutSecrets(s);
      return performance.now() - t0;
    };
    const unit = "1 2 3 ABCDE12 HDFC0 x ".repeat(100);
    time(unit.repeat(50)); // warm up
    const small = Math.max(time(unit.repeat(10)), 0.05);
    const large = time(unit.repeat(100));
    expect(large / small).toBeLessThan(60);
  });
});

describe("scrubPayoutObject", () => {
  it("scrubs every string, nested, including keys", () => {
    const out = scrubPayoutObject({ error: { description: "bad account 1234567890123456", list: ["ABCPE1234F", "fine"] }, "key 12345678": 1 });
    expect(JSON.stringify(out)).not.toMatch(/1234567890123456|ABCPE1234F|12345678/);
    expect(out).toMatchObject({ error: { description: "bad account [redacted]", list: [REDACTED, "fine"] } });
  });

  it("redacts the value of a sensitive key whatever it looks like, in any spelling", () => {
    const out = scrubPayoutObject({
      pan: "x",
      account_number: 42,
      accountNumber: "7",
      "Account-Number": "7",
      ifsc_code: "z",
      ifsc: "z",
      beneficiary_name: "Gaurav Kumar",
      legal_business_name: "Gaurav Kumar",
      street1: "506 Koramangala",
      postal_code: "560034",
      phone: "9000090000",
      amount: 12345,
    }) as Record<string, unknown>;
    for (const k of Object.keys(out)) {
      if (k === "amount") continue;
      expect(out[k]).toBe(REDACTED);
    }
    expect(out.amount).toBe(12345); // money is not a secret and stays readable
  });

  it("keeps null under a sensitive key as null (nothing to hide) and drops undefined and functions", () => {
    const out = scrubPayoutObject({ pan: null, gone: undefined, fn: () => 1, sym: Symbol("x"), ok: true }) as Record<string, unknown>;
    expect(out).toEqual({ pan: null, ok: true });
  });

  it("reduces an Error to name, message and code, scrubbed", () => {
    const err = Object.assign(new Error("Invalid IFSC Code HDFC0000317"), { code: "BAD_REQUEST_ERROR", status: 400, stack: "secret stack 1234567890" });
    const out = scrubPayoutObject({ err }) as { err: Record<string, unknown> };
    expect(out.err).toEqual({ name: "Error", message: "Invalid IFSC Code [redacted]", code: "BAD_REQUEST_ERROR", status: 400 });
  });

  it("does not mutate its input", () => {
    const input = { pan: "ABCPE1234F", nested: { n: "1234567890" }, arr: ["ABCPE1234F"] };
    const snapshot = JSON.stringify(input);
    scrubPayoutObject(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("survives cycles, shared references and very deep objects", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const shared = { v: 1 };
    const out = scrubPayoutObject({ a, x: shared, y: shared }) as Record<string, any>;
    expect(out.a.self).toBe("[circular]");
    expect(out.x).toEqual({ v: 1 });
    expect(out.y).toEqual({ v: 1 }); // the same object twice is not a cycle

    let deep: Record<string, unknown> = { leaf: "1234567890" };
    for (let i = 0; i < 50; i++) deep = { child: deep };
    expect(() => scrubPayoutObject(deep)).not.toThrow();
    expect(JSON.stringify(scrubPayoutObject(deep))).toContain("[truncated]");
  });

  it("bounds a huge object instead of walking all of it", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 20_000; i++) big[`k${i}`] = i;
    const out = scrubPayoutObject(big) as Record<string, unknown>;
    expect(Object.values(out).filter((v) => v === "[truncated]").length).toBeGreaterThan(0);
  });

  it("cannot be used to swap a prototype through a __proto__ key", () => {
    const evil = JSON.parse('{"__proto__": {"polluted": "yes"}, "a": 1}');
    const out = scrubPayoutObject(evil) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.a).toBe(1);
  });

  it("turns dates, binary data, bigint and non-finite numbers into JSON-safe values", () => {
    const out = scrubPayoutObject({ d: new Date("2026-10-12T00:00:00Z"), bin: Buffer.from("x"), big: BigInt("12345678901234567890"), nan: NaN, inf: Infinity }) as Record<string, unknown>;
    expect(out).toEqual({ d: "2026-10-12T00:00:00.000Z", bin: "[binary]", big: REDACTED, nan: null, inf: null });
  });
});

describe("masked hints", () => {
  it("lastFour reads digits only and refuses anything it cannot be sure of", () => {
    expect(lastFour("1234567890123456")).toBe("3456");
    expect(lastFour("1234 5678 9012 3456")).toBe("3456");
    expect(lastFour("XXXXXX1234")).toBe("1234");
    expect(lastFour(7878780080310012)).toBe("0012");
    expect(lastFour("123")).toBeNull();
    expect(lastFour("")).toBeNull();
    expect(lastFour(null)).toBeNull();
    expect(lastFour(undefined)).toBeNull();
    expect(lastFour({})).toBeNull();
    // A number past 2^53 has already lost its low digits when JSON.parse hands it over.
    expect(lastFour(12345678901234567890)).toBeNull();
    expect(lastFour(-1234567)).toBeNull();
  });

  it("destinationHint is the bank code plus the last four digits, nothing more", () => {
    expect(destinationHint("HDFC0000317", "1234567890123456")).toBe("HDFC ••••3456");
    expect(destinationHint("hdfc0000317", "1234567890123456")).toBe("HDFC ••••3456");
    expect(destinationHint(null, "1234567890123456")).toBe("••••3456");
    expect(destinationHint("12345678901", "1234567890123456")).toBe("••••3456");
    expect(destinationHint("HDFC0000317", "12")).toBeNull();
    const hint = destinationHint("HDFC0000317", "1234567890123456") as string;
    expect(hint).not.toContain("0000317");
    expect(hint).not.toContain("123456789012");
  });
});
