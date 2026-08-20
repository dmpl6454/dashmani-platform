/**
 * token-crypto.ts — the first at-rest encryption in this repo.
 *
 * These tests lock the properties that make it worth having at all: a tampered
 * ciphertext must FAIL rather than decrypt to garbage, a plaintext value must be
 * REJECTED rather than passed through, and secrets must never survive scrubbing
 * into a log line or a stored lastError.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  encryptToken,
  decryptToken,
  redactToken,
  scrubSecrets,
  tokenCryptoConfigured,
  assertTokenCryptoReady,
  SecretFormatError,
  __resetKeyCacheForTesting,
} from "../src/utils/token-crypto";

const ORIGINAL_KEY = process.env.META_TOKEN_ENC_KEY;

beforeEach(() => {
  process.env.META_TOKEN_ENC_KEY = "test-key-do-not-use-in-production-0123456789";
  __resetKeyCacheForTesting();
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.META_TOKEN_ENC_KEY;
  else process.env.META_TOKEN_ENC_KEY = ORIGINAL_KEY;
  __resetKeyCacheForTesting();
});

describe("token-crypto — round trip", () => {
  it("round-trips a realistic Meta token", () => {
    // Shaped like a Meta token (EAA prefix, ~200 chars) but entirely synthetic.
    const token = "EAAsyntheticTokenPrefix" + "x".repeat(180);
    const enc = encryptToken(token);
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(enc).not.toContain(token);
    expect(decryptToken(enc)).toBe(token);
  });

  it("produces a DIFFERENT ciphertext each time (random IV)", () => {
    // A deterministic ciphertext would leak that two assets share a token.
    const a = encryptToken("same-token");
    const b = encryptToken("same-token");
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe("same-token");
    expect(decryptToken(b)).toBe("same-token");
  });

  it("refuses to encrypt an empty value", () => {
    expect(() => encryptToken("")).toThrow(SecretFormatError);
  });
});

describe("token-crypto — refuses to be decorative", () => {
  it("REJECTS a plaintext value instead of passing it through", () => {
    // The whole mechanism is pointless if a mis-migrated plaintext row keeps working.
    expect(() => decryptToken("EAAplaintexttoken")).toThrow(SecretFormatError);
  });

  it("rejects a malformed envelope", () => {
    expect(() => decryptToken("enc:v1:only-one-part")).toThrow(SecretFormatError);
    expect(() => decryptToken("enc:v1:a.b")).toThrow(SecretFormatError);
  });

  it("DETECTS tampering rather than decrypting to garbage (GCM, not CBC)", () => {
    const enc = encryptToken("sensitive-page-token");
    const [prefixed, tag, ct] = [enc.slice(0, enc.indexOf(".")), ...enc.slice(enc.indexOf(".") + 1).split(".")];
    // Flip a byte in the ciphertext segment.
    const flipped = Buffer.from(ct, "base64url");
    flipped[0] = flipped[0] ^ 0xff;
    const tampered = `${prefixed}.${tag}.${flipped.toString("base64url")}`;
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("fails to decrypt under a DIFFERENT key (no silent cross-key read)", () => {
    const enc = encryptToken("token-under-key-A");
    process.env.META_TOKEN_ENC_KEY = "a-completely-different-key-9876543210";
    __resetKeyCacheForTesting();
    expect(() => decryptToken(enc)).toThrow();
  });
});

describe("token-crypto — configuration gate (NO fallback key)", () => {
  it("reports unconfigured and throws when the key is absent", () => {
    delete process.env.META_TOKEN_ENC_KEY;
    __resetKeyCacheForTesting();
    expect(tokenCryptoConfigured()).toBe(false);
    // Must NOT silently fall back to JWT_SECRET: rotating JWT_SECRET (a routine,
    // cheap action) would otherwise render every stored token undecryptable.
    process.env.JWT_SECRET = "some-jwt-secret";
    expect(() => assertTokenCryptoReady()).toThrow(/META_TOKEN_ENC_KEY/);
    expect(() => encryptToken("x")).toThrow(/META_TOKEN_ENC_KEY/);
  });

  it("treats a whitespace-only key as absent", () => {
    process.env.META_TOKEN_ENC_KEY = "   ";
    __resetKeyCacheForTesting();
    expect(tokenCryptoConfigured()).toBe(false);
  });
});

describe("scrubSecrets — nothing secret reaches a log or lastError", () => {
  it("redacts access_token in a URL", () => {
    const s = scrubSecrets("GET https://graph.facebook.com/v21.0/me?access_token=EAAsecretvalue123456789012345");
    expect(s).not.toContain("EAAsecretvalue123456789012345");
    expect(s).toContain("[REDACTED]");
  });

  it("redacts client_secret and code", () => {
    // Deliberately synthetic values — never a fragment of a real credential.
    const s = scrubSecrets("oauth/access_token?client_secret=FAKESECRET0000dead&code=AQBfakecode123");
    expect(s).not.toContain("FAKESECRET0000dead");
    expect(s).not.toContain("AQBfakecode123");
  });

  it("redacts a JSON access_token field", () => {
    const s = scrubSecrets('{"access_token":"EAAabcdefghijklmnop","token_type":"bearer"}');
    expect(s).not.toContain("EAAabcdefghijklmnop");
    expect(s).toContain('"access_token":"[REDACTED]"');
  });

  it("redacts a bare EAA token with no surrounding key", () => {
    // Graph error bodies routinely echo a bare token.
    const s = scrubSecrets("Invalid OAuth token EAAfakeTokenValue0000000000000000");
    expect(s).not.toContain("EAAfakeTokenValue0000000000000000");
  });

  it("redacts the appId|secret app-token form", () => {
    const s = scrubSecrets("access denied for 298449321694397|FAKEAPPTOKEN0000000000");
    expect(s).not.toContain("FAKEAPPTOKEN0000000000");
  });

  it("redacts our own envelope if it leaks into a message", () => {
    const enc = encryptToken("inner-token");
    expect(scrubSecrets(`failed to use ${enc}`)).not.toContain(enc.split(":")[2]);
  });

  it("is safe on empty/degenerate input", () => {
    expect(scrubSecrets("")).toBe("");
    expect(scrubSecrets("nothing sensitive here")).toBe("nothing sensitive here");
  });
});

describe("redactToken", () => {
  it("never returns ciphertext bytes", () => {
    const enc = encryptToken("abc");
    const r = redactToken(enc);
    expect(r).toBe("enc:v1:…(redacted)");
    expect(r).not.toContain(enc.slice(10));
  });

  it("handles null/undefined", () => {
    expect(redactToken(null)).toBe("(none)");
    expect(redactToken(undefined)).toBe("(none)");
  });
});
