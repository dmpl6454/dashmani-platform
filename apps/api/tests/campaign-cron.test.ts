/**
 * The campaign cron's two kill switches (cron/campaign.cron.ts): CAMPAIGN_CRONS_ENABLED=0 stops the
 * render, publish and retention workers but NOT the refund sweep (money recovery), and
 * CAMPAIGN_REFUND_SWEEP_ENABLED=0 stops only the sweep.
 *
 * Before this file nothing imported the cron, so moving the sweep below the umbrella check (which
 * silently stops refund recovery whenever an operator calms a busy box with CAMPAIGN_CRONS_ENABLED=0
 * while staff are still told "we're checking automatically"), dropping its overlap flag or reading
 * the switch the wrong way passed the whole suite. The real switch reader (refundSweepEnabled) is
 * kept; only the four workers are stubbed, and time is fake, so nothing here waits or touches
 * Razorpay or the database.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const workers = vi.hoisted(() => ({ sweep: vi.fn(), render: vi.fn(), publish: vi.fn(), retention: vi.fn() }));

vi.mock("../src/services/campaign/payment.service", async (orig) => ({
  ...(await orig<typeof import("../src/services/campaign/payment.service")>()),
  sweepRefundDue: workers.sweep,
}));
vi.mock("../src/services/campaign/render.service", () => ({ renderNext: workers.render }));
vi.mock("../src/services/campaign/publish.service", () => ({ runPublishTick: workers.publish }));
vi.mock("../src/services/campaign/retention.service", () => ({ runCampaignRetention: workers.retention }));

const MIN = 60_000;
const SWITCHES = ["CAMPAIGN_CRONS_ENABLED", "CAMPAIGN_REFUND_SWEEP_ENABLED"] as const;

describe("startCampaignCrons: the kill switches", () => {
  const saved: Record<string, string | undefined> = {};
  let warn: { mock: { calls: unknown[][] } };
  let error: { mock: { calls: unknown[][] } };
  const warned = () => warn.mock.calls.flat().join(" ");

  // Inside a describe on purpose: the suite's TRUNCATE (tests/setup.ts) runs in a top-level hook, and these hooks come after it.
  beforeEach(() => {
    for (const k of SWITCHES) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    vi.useFakeTimers();
    vi.resetModules(); // a fresh module: its overlap flags start false
    workers.sweep.mockReset().mockResolvedValue({ issued: 0, reconciled: 0, resumed: 0, errors: 0 });
    workers.render.mockReset().mockResolvedValue(undefined);
    workers.publish.mockReset().mockResolvedValue(undefined);
    workers.retention.mockReset().mockResolvedValue({});
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const k of SWITCHES) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function start() {
    const { startCampaignCrons } = await import("../src/cron/campaign.cron");
    startCampaignCrons();
  }

  it("by default every worker is scheduled: render, publish, the refund sweep and retention", async () => {
    await start();
    expect(warned()).not.toContain("NOT running");
    await vi.advanceTimersByTimeAsync(MIN);
    expect(workers.render).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(workers.publish).toHaveBeenCalledTimes(1);
    expect(workers.sweep).not.toHaveBeenCalled(); // first run 4 minutes after boot
    await vi.advanceTimersByTimeAsync(MIN);
    expect(workers.sweep).toHaveBeenCalledTimes(1);
    expect(workers.retention).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16 * MIN); // 20 minutes after boot
    expect(workers.retention).toHaveBeenCalledTimes(1);
  });

  it("CAMPAIGN_CRONS_ENABLED=0 still runs the refund sweep, and stops render, publish and retention, and says so", async () => {
    vi.stubEnv("CAMPAIGN_CRONS_ENABLED", "0");
    await start();
    expect(warned()).toContain("CAMPAIGN_CRONS_ENABLED=0");
    expect(warned()).toContain("refund sweep is not affected");

    await vi.advanceTimersByTimeAsync(4 * MIN - 1);
    expect(workers.sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(workers.sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(workers.sweep).toHaveBeenCalledTimes(2);

    // Well past every other worker's first run (render 1 min, publish 3 min, retention 20 min).
    await vi.advanceTimersByTimeAsync(25 * MIN);
    expect(workers.sweep.mock.calls.length).toBeGreaterThan(2);
    expect(workers.render).not.toHaveBeenCalled();
    expect(workers.publish).not.toHaveBeenCalled();
    expect(workers.retention).not.toHaveBeenCalled();
  });

  it("CAMPAIGN_REFUND_SWEEP_ENABLED=0 stops only the sweep, and says so", async () => {
    vi.stubEnv("CAMPAIGN_REFUND_SWEEP_ENABLED", "0");
    await start();
    expect(warned()).toContain("CAMPAIGN_REFUND_SWEEP_ENABLED=0");
    expect(warned()).toContain("refund sweep is NOT running");

    await vi.advanceTimersByTimeAsync(21 * MIN);
    expect(workers.sweep).not.toHaveBeenCalled();
    expect(workers.render).toHaveBeenCalled();
    expect(workers.publish).toHaveBeenCalled();
    expect(workers.retention).toHaveBeenCalledTimes(1);
  });

  it("with both switches off nothing runs", async () => {
    vi.stubEnv("CAMPAIGN_CRONS_ENABLED", "0");
    vi.stubEnv("CAMPAIGN_REFUND_SWEEP_ENABLED", "0");
    await start();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    for (const w of Object.values(workers)) expect(w).not.toHaveBeenCalled();
    expect(warned()).toContain("CAMPAIGN_CRONS_ENABLED=0");
    expect(warned()).toContain("CAMPAIGN_REFUND_SWEEP_ENABLED=0");
  });

  it("a slow sweep is never stacked: while one is running the next ticks skip, and it runs again once that one ends", async () => {
    let finish!: (s: { issued: number; reconciled: number; resumed: number; errors: number }) => void;
    workers.sweep.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await start();
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(workers.sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3 * MIN); // three more ticks while the first has not finished
    expect(workers.sweep).toHaveBeenCalledTimes(1);

    finish({ issued: 0, reconciled: 0, resumed: 0, errors: 0 });
    await vi.advanceTimersByTimeAsync(MIN);
    expect(workers.sweep).toHaveBeenCalledTimes(2);
  });

  it("a sweep that throws is logged and does not stop the next tick", async () => {
    workers.sweep.mockRejectedValueOnce(new Error("boom"));
    await start();
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(workers.sweep).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.flat().join(" ")).toContain("sweep failed");
    await vi.advanceTimersByTimeAsync(MIN);
    expect(workers.sweep).toHaveBeenCalledTimes(2);
  });
});
