import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Spec §9.3 — every `pl:` localStorage key is purged when an HR session ends, AND when
 * login() receives a different user than the one stored. The third case covers a shared
 * device where person B signs in over person A's still-valid session without A ever
 * signing out: A's Pipeline drafts / outbox must not survive into B's session.
 *
 * Tests the REAL apps/hr module with a stubbed localStorage (apps/hr has no harness).
 */

class MemoryStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return Array.from(this.m.keys())[i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  keys() { return Array.from(this.m.keys()); }
}

let storage: MemoryStorage;

async function load() {
  vi.resetModules();
  return import("../../../hr/src/lib/pipeline-storage");
}

const plKeys = () => storage.keys().filter((k) => k.startsWith("pl:")).sort();

beforeEach(() => {
  storage = new MemoryStorage();
  storage.setItem("hrUser", JSON.stringify({ id: "user-a", name: "A" }));
  storage.setItem("pl:v1:user-a:outbox", "[]");
  storage.setItem("pl:v1:user-a:draft:p1", "hello");
  storage.setItem("unrelated-pref", "keep-me");
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("purgePipelineStorageOnUserSwitch", () => {
  it("a DIFFERENT incoming user purges every pl: key and nothing else", async () => {
    const { purgePipelineStorageOnUserSwitch } = await load();
    purgePipelineStorageOnUserSwitch("user-b");
    expect(plKeys()).toEqual([]);
    expect(storage.getItem("unrelated-pref")).toBe("keep-me");
    expect(storage.getItem("hrUser")).not.toBeNull(); // auth keys are login()'s business
  });

  it("the SAME user signing in again keeps their drafts", async () => {
    const { purgePipelineStorageOnUserSwitch } = await load();
    purgePipelineStorageOnUserSwitch("user-a");
    expect(plKeys()).toEqual(["pl:v1:user-a:draft:p1", "pl:v1:user-a:outbox"]);
  });

  it("no stored user → nothing to compare, nothing purged", async () => {
    storage.removeItem("hrUser");
    const { purgePipelineStorageOnUserSwitch } = await load();
    purgePipelineStorageOnUserSwitch("user-b");
    expect(plKeys()).toHaveLength(2);
  });

  it("an unparseable or id-less stored user does not throw and purges nothing", async () => {
    const { purgePipelineStorageOnUserSwitch } = await load();
    storage.setItem("hrUser", "{not json");
    expect(() => purgePipelineStorageOnUserSwitch("user-b")).not.toThrow();
    storage.setItem("hrUser", JSON.stringify({ name: "no id" }));
    purgePipelineStorageOnUserSwitch("user-b");
    expect(plKeys()).toHaveLength(2);
  });

  it("blocked storage (private mode) does not throw", async () => {
    vi.stubGlobal("localStorage", {
      get length() { throw new Error("SecurityError"); },
      getItem() { throw new Error("SecurityError"); },
    });
    const { purgePipelineStorageOnUserSwitch } = await load();
    expect(() => purgePipelineStorageOnUserSwitch("user-b")).not.toThrow();
  });
});
