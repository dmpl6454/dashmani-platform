import { renderNext } from "../services/campaign/render.service";
import { runCampaignRetention } from "../services/campaign/retention.service";

// Campaign booking background work:
//  • render worker — every 30 s, at most ONE file per tick (renderNext has its own overlap
//    guard and skips when the box is busy). Kill switch: CAMPAIGN_RENDER_ENABLED=0.
//  • retention — every 6 h, first run 20 min after boot.
// Neither ever throws into the event loop.

let retentionRunning = false;

export function startCampaignCrons() {
  if (process.env.CAMPAIGN_CRONS_ENABLED === "0") return;

  const renderTick = () => {
    renderNext().catch((err) => console.error("[campaign-render] tick failed:", err));
  };
  setTimeout(() => {
    renderTick();
    setInterval(renderTick, 30_000);
  }, 60_000);

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
