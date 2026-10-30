import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, notifyAdminByEmail: vi.fn(async () => null) };
});

import { notifyAdminByEmail } from "../src/services/email.service";
import { checkDisk, diskTools, judgeDisk, resetDiskWatch } from "../src/services/disk-watch.service";

const GB = 1024 ** 3;
const realRead = diskTools.read;
const realNow = diskTools.now;

describe("disk watch", () => {
  beforeEach(() => {
    resetDiskWatch();
    vi.mocked(notifyAdminByEmail).mockClear();
  });
  afterEach(() => {
    diskTools.read = realRead;
    diskTools.now = realNow;
  });

  it("judges by free GB and free percent", () => {
    expect(judgeDisk({ freeBytes: 12 * GB, totalBytes: 49 * GB }, 8, 15).low).toBe(false);
    expect(judgeDisk({ freeBytes: 7 * GB, totalBytes: 49 * GB }, 8, 15).low).toBe(true);
    expect(judgeDisk({ freeBytes: 9 * GB, totalBytes: 100 * GB }, 8, 15).low).toBe(true); // 9% < 15%
  });

  it("emails once a day while low, and stays quiet when there is room", async () => {
    let t = 1_000_000;
    diskTools.now = () => t;
    diskTools.read = async () => ({ freeBytes: 20 * GB, totalBytes: 49 * GB });
    expect((await checkDisk()).alerted).toBe(false);

    diskTools.read = async () => ({ freeBytes: 3 * GB, totalBytes: 49 * GB });
    const first = await checkDisk();
    expect(first.alerted).toBe(true);
    expect(vi.mocked(notifyAdminByEmail).mock.calls[0][0]).toBe("Server disk is getting full");
    t += 3600_000;
    expect((await checkDisk()).alerted).toBe(false);
    t += 24 * 3600_000;
    expect((await checkDisk()).alerted).toBe(true);
    expect(notifyAdminByEmail).toHaveBeenCalledTimes(2);
  });

  it("never throws when the disk can't be read", async () => {
    diskTools.read = async () => {
      throw new Error("statfs failed");
    };
    expect(await checkDisk()).toEqual({ verdict: null, alerted: false });
  });
});
