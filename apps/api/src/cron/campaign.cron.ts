import { renderNext } from "../services/campaign/render.service";
import { runCampaignRetention } from "../services/campaign/retention.service";
import { runPublishTick } from "../services/campaign/publish.service";
import { sweepRefundDue, refundSweepEnabled } from "../services/campaign/payment.service";

// Campaign booking background work:
//  • render worker — every 30 s, at most ONE file per tick (renderNext has its own overlap
//    guard and skips when the box is busy). Kill switch: CAMPAIGN_RENDER_ENABLED=0 (stops only
//    ffmpeg: the switch for a load incident).
//  • retention — every 6 h, first run 20 min after boot.
//  • publish (Phase 2) — every 60 s, first run 3 min after boot; a no-op unless
//    CAMPAIGN_PUBLISH_ENABLED=1. runPublishTick has its own overlap guard.
//  • refund sweep — every 60 s, first run 4 min after boot. Finishes refunds that were
//    interrupted (a payment left refund_due, a refund Razorpay never answered, a refund event
//    whose list could not be read, an item refund that failed). With no Razorpay keys (offline
//    mode) it returns at once.
// None of them ever throws into the event loop.
//
// ⚠️ Two switches, deliberately separate:
//  • CAMPAIGN_CRONS_ENABLED=0 stops render, publish and retention (and says so in the log). It
//    does NOT stop the refund sweep: that is money recovery, and an umbrella flag set to calm a
//    busy box must not silently leave a brand's refund unfinished.
//  • CAMPAIGN_REFUND_SWEEP_ENABLED=0 stops the sweep (it makes outbound Razorpay calls, so an
//    operator may need it off during a Razorpay incident). Interrupted refunds then wait, safely
//    (the state is in the database and the re-send reuses its idempotency keys), until it is
//    switched on and the API restarted. Both flags are read once, at boot. The staff-facing refund
//    notices read the same switch (refundSweepEnabled), so they never promise a check that is off.

let retentionRunning = false;
let refundSweepRunning = false;

function startRefundSweep() {
  if (!refundSweepEnabled()) {
    console.warn("[campaign] CAMPAIGN_REFUND_SWEEP_ENABLED=0: the refund sweep is NOT running. Interrupted refunds wait until it is switched on and the API restarted.");
    return;
  }
  // The overlap flag is claimed before the first await, so a slow Razorpay call can never stack ticks.
  const refundSweepTick = async () => {
    if (refundSweepRunning) return;
    refundSweepRunning = true;
    try {
      const s = await sweepRefundDue();
      if (Object.values(s).some((n) => n > 0)) console.log("[campaign-refunds]", JSON.stringify(s));
    } catch (err) {
      console.error("[campaign-refunds] sweep failed:", err);
    } finally {
      refundSweepRunning = false;
    }
  };
  setTimeout(() => {
    void refundSweepTick();
    setInterval(() => void refundSweepTick(), 60_000);
  }, 4 * 60_000);
}

export function startCampaignCrons() {
  // Registered before the umbrella check on purpose (see the header).
  startRefundSweep();

  if (process.env.CAMPAIGN_CRONS_ENABLED === "0") {
    console.warn("[campaign] CAMPAIGN_CRONS_ENABLED=0: the render, publish and retention workers are NOT running. The refund sweep is not affected by this flag.");
    return;
  }

  const renderTick = () => {
    renderNext().catch((err) => console.error("[campaign-render] tick failed:", err));
  };
  setTimeout(() => {
    renderTick();
    setInterval(renderTick, 30_000);
  }, 60_000);

  const publishTick = () => {
    runPublishTick().catch((err) => console.error("[campaign-publish] tick failed:", err));
  };
  setTimeout(() => {
    publishTick();
    setInterval(publishTick, 60_000);
  }, 3 * 60_000);

  const retentionTick = async () => {
    if (retentionRunning) return;
    retentionRunning = true;
    try {
      const s = await runCampaignRetention();
      if (Object.values(s).some((n) => n > 0)) console.log("[campaign-retention]", JSON.stringify(s));
    } catch (err) {
      console.error("[campaign-retention] failed:", err);
    } finally {
      retentionRunning = false;
    }
  };
  setTimeout(() => {
    void retentionTick();
    setInterval(() => void retentionTick(), 6 * 3600_000);
  }, 20 * 60_000);
}
