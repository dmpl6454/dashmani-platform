import { describe, it, expect, vi, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import { createTestUser, generateHrToken, generateToken } from "../helpers";
import { verifyAccessToken } from "../../src/utils/jwt";

/**
 * P7 — test helpers the pipeline suites rely on.
 *
 * `createTestUser()` used to default the email to `test-${Date.now()}@test.com`, so two
 * users created in the same millisecond collided on the `users.email` UNIQUE constraint
 * (a P2002 flake). The pipeline suites create several users per test in parallel, so the
 * default must be unique even when the clock does not move.
 */
describe("P7 test helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("20 parallel createTestUser() calls with no email give 20 distinct emails", async () => {
    const users = await Promise.all(Array.from({ length: 20 }, () => createTestUser()));
    const emails = new Set(users.map((u) => u.email));
    expect(emails.size).toBe(20);
  }, 60_000);

  it("default emails stay unique even when Date.now() does not advance", async () => {
    // Freeze the clock so the only thing that can separate the emails is the counter.
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const a = await createTestUser();
    const b = await createTestUser();
    vi.restoreAllMocks();
    expect(a.email).not.toBe(b.email);
  }, 60_000);

  it("an explicit email is still used verbatim", async () => {
    const u = await createTestUser({ email: "explicit-p7@test.com" });
    expect(u.email).toBe("explicit-p7@test.com");
  }, 60_000);

  it("generateHrToken(id, email) verifies as an HR access token", () => {
    const token = generateHrToken("00000000-0000-0000-0000-000000000001", "hr-p7@test.com");
    const payload = verifyAccessToken(token);
    expect(payload.type).toBe("hr");
    expect(payload.userId).toBe("00000000-0000-0000-0000-000000000001");
    expect(payload.email).toBe("hr-p7@test.com");
    expect(payload.roles).toEqual([]);
  });

  it("generateHrToken is signed with the same secret as generateToken", () => {
    const secret = process.env.JWT_SECRET || "dev-secret";
    const hr = jwt.verify(generateHrToken("u1", "a@test.com"), secret) as { type: string };
    const emp = jwt.verify(generateToken("u1", "a@test.com"), secret) as { type: string };
    expect(hr.type).toBe("hr");
    expect(emp.type).toBe("employee");
  });

  it("the main suite runs the pipeline pool at 1 connection", () => {
    expect(process.env.PIPELINE_DB_CONNECTIONS).toBe("1");
  });
});
