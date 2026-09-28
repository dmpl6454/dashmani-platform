import { describe, it, expect } from "vitest";
import { classifyRefreshOutcome } from "@dashmani/shared";

/**
 * P1 — the HR portal's token refresh has THREE outcomes, not two.
 *
 * Before P1 every failure (a network blip, a 502 HTML page from nginx, a 429 from the
 * limiter) was treated as "the session is over": the tokens were wiped and the user was
 * hard-redirected to /login. Only a deliberate JSON refusal from the refresh endpoint
 * means the session is actually over.
 */
describe("classifyRefreshOutcome (P1)", () => {
  describe("the plan's table", () => {
    it("fetch threw (offline / DNS / CORS / connection reset) → transient", () => {
      expect(classifyRefreshOutcome({ threw: true })).toBe("transient");
    });

    it("502 with an HTML body (nginx / Cloudflare error page) → transient", () => {
      expect(classifyRefreshOutcome({ threw: false, status: 502, isJson: false })).toBe("transient");
    });

    it("429 → transient (the limiter is not a verdict on the session)", () => {
      expect(classifyRefreshOutcome({ threw: false, status: 429, isJson: true })).toBe("transient");
      expect(classifyRefreshOutcome({ threw: false, status: 429, isJson: false })).toBe("transient");
    });

    it("503 → transient", () => {
      expect(classifyRefreshOutcome({ threw: false, status: 503, isJson: true })).toBe("transient");
      expect(classifyRefreshOutcome({ threw: false, status: 503, isJson: false })).toBe("transient");
    });

    it("400 with JSON (refreshToken missing) → rejected", () => {
      expect(classifyRefreshOutcome({ threw: false, status: 400, isJson: true })).toBe("rejected");
    });

    it("401 with JSON (invalid / expired / already-used refresh token) → rejected", () => {
      expect(classifyRefreshOutcome({ threw: false, status: 401, isJson: true })).toBe("rejected");
    });

    it("200 with JSON → ok", () => {
      expect(classifyRefreshOutcome({ threw: false, status: 200, isJson: true })).toBe("ok");
    });
  });

  describe("edges the table implies", () => {
    it("a JSON 500 from our own errorHandler (DB down, P2024) is transient, not a verdict", () => {
      expect(classifyRefreshOutcome({ threw: false, status: 500, isJson: true })).toBe("transient");
    });

    it("any 5xx is transient", () => {
      for (const s of [500, 502, 503, 504, 520, 522, 524]) {
        expect(classifyRefreshOutcome({ threw: false, status: s, isJson: false })).toBe("transient");
      }
    });

    it("a NON-JSON 400 / 401 (a proxy page, not our API) is transient — only a JSON answer is a verdict", () => {
      expect(classifyRefreshOutcome({ threw: false, status: 400, isJson: false })).toBe("transient");
      expect(classifyRefreshOutcome({ threw: false, status: 401, isJson: false })).toBe("transient");
    });

    it("a NON-JSON 200 (captive portal, truncated body) is transient, never ok", () => {
      expect(classifyRefreshOutcome({ threw: false, status: 200, isJson: false })).toBe("transient");
    });

    it("threw wins over any status that may also be present", () => {
      expect(classifyRefreshOutcome({ threw: true, status: 401, isJson: true })).toBe("transient");
    });

    it("a missing status is transient (nothing was actually answered)", () => {
      expect(classifyRefreshOutcome({ threw: false })).toBe("transient");
      expect(classifyRefreshOutcome({ threw: false, isJson: true })).toBe("transient");
    });

    it("status 0 (an opaque / aborted response) is transient", () => {
      expect(classifyRefreshOutcome({ threw: false, status: 0, isJson: false })).toBe("transient");
    });

    it("other JSON 4xx from the refresh endpoint are a deliberate refusal → rejected", () => {
      for (const s of [403, 404, 409, 422]) {
        expect(classifyRefreshOutcome({ threw: false, status: s, isJson: true })).toBe("rejected");
      }
    });

    it("a JSON 3xx is not a success → transient", () => {
      expect(classifyRefreshOutcome({ threw: false, status: 304, isJson: true })).toBe("transient");
    });

    it("any JSON 2xx is ok", () => {
      expect(classifyRefreshOutcome({ threw: false, status: 201, isJson: true })).toBe("ok");
    });
  });
});
