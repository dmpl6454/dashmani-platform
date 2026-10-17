/**
 * payout-privacy.test.ts — the POSITIVE CONTROLS for the instruments every payout privacy test relies on
 * (tests/payout-privacy.ts). A "no table holds X" or "nothing was logged" assertion proves something only if
 * the scan and the spy can fail. Here a value is planted and each instrument must find it, and a value that
 * was never planted must not be found. If a later edit to the scan's quoting, schema filter or parameter
 * typing made it match nothing, or to the spy made it blind to an Error's message, THIS file goes red and
 * the privacy suites are known to be blind, rather than quietly green.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@dashmani/db";
import "./setup";
import { createTestUser } from "./helpers";
import { captureConsole, renderLogArgs, scanDatabase, type ConsoleCapture } from "./payout-privacy";

describe("scanDatabase (positive control)", () => {
  it("finds a planted value in three different tables, and nothing for a value that was never planted", async () => {
    const needle = `PLANTED-${randomUUID()}`;
    const user = await createTestUser({ name: "Privacy Control" });
    await prisma.auditLog.create({ data: { userId: user.id, action: "control", resource: "payout", after: { note: needle } } });
    await prisma.creatorPayoutEvent.create({ data: { payoutId: randomUUID(), kind: "manual", note: `a note that carries ${needle} in the middle` } });
    await prisma.creatorPayoutAccount.create({ data: { creatorId: randomUUID(), lastError: needle } });

    expect(await scanDatabase([needle])).toEqual(["audit_logs", "creator_payout_accounts", "creator_payout_events"]);
    expect(await scanDatabase([`NEVER-PLANTED-${randomUUID()}`])).toEqual([]);
    // several needles are OR-ed: one planted and one not still finds the planted one's tables
    expect(await scanDatabase([`NEVER-PLANTED-${randomUUID()}`, needle])).toHaveLength(3);
  });

  it("matches regardless of case and across spaces, the way the privacy tests use it (names, streets)", async () => {
    await prisma.creatorPayoutEvent.create({ data: { payoutId: randomUUID(), kind: "manual", note: "Quillfeather Marg 77 near the ZoRbAxIa Tower" } });
    expect(await scanDatabase(["quillfeather marg 77"])).toEqual(["creator_payout_events"]);
    expect(await scanDatabase(["zorbaxia tower"])).toEqual(["creator_payout_events"]);
    expect(await scanDatabase(["Quillfeather Marg 78"])).toEqual([]);
  });
});

class ProviderError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

describe("captureConsole (positive control)", () => {
  let cap: ConsoleCapture | null = null;
  afterEach(() => {
    cap?.restore();
    cap = null;
  });
  const all = () => cap!.lines.join("\n");

  it("a naive JSON.stringify of an Error is blind to its message (why this spy renders errors itself)", () => {
    const needle = `PLANTED-${randomUUID()}`;
    expect(JSON.stringify(new ProviderError(needle))).not.toContain(needle);
    expect(renderLogArgs([new ProviderError(needle)])).toContain(needle);
  });

  it("sees a planted value in a string, an object, an Error's message, its stack, a nested Error and a cause", () => {
    cap = captureConsole();
    const n = (k: string) => `PLANTED-${k}-${randomUUID()}`;
    const [s, o, m, st, nested, cause, fmt] = [n("string"), n("object"), n("message"), n("stack"), n("nested"), n("cause"), n("format")];
    const stacked = new ProviderError("fine");
    stacked.stack = `ProviderError: fine\n    at ${st} (somewhere.ts:1:1)`;

    console.log(`a line with ${s}`);
    console.warn({ deep: { value: o } });
    console.error("poll failed", new ProviderError(m));
    console.error(stacked);
    console.error("wrapped", { err: new ProviderError(nested) });
    console.error(new Error("outer", { cause: new ProviderError(cause) }));
    console.info("%s and %d", fmt, 7);

    for (const needle of [s, o, m, st, nested, cause, fmt]) expect(all(), needle).toContain(needle);
    expect(cap.lines).toHaveLength(7);
  });

  it("finds nothing that was not written, and writes nothing to the real console while it is on", () => {
    cap = captureConsole();
    console.error("poll failed for some-id: SERVER_ERROR 500");
    expect(all()).not.toContain("PLANTED");
    expect(all()).toContain("poll failed for some-id");
    cap.restore();
    cap = null;
    // after restore() console is the real one again: a new capture starts empty
    const again = captureConsole();
    expect(again.lines).toEqual([]);
    again.restore();
  });
});
