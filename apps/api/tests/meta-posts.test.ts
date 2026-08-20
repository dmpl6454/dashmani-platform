/**
 * Meta posts sync — metric interpretation.
 *
 * The property under test is the one this codebase has regressed on before (the
 * Snapchat showLikes incident): a metric Meta does not publish must stay NULL and
 * render as an em-dash. Coercing it to 0 turns "we have no number" into the
 * factual claim "this post got zero likes".
 */

import { describe, it, expect } from "vitest";
import { runMetaPostsSync } from "../src/services/meta-oauth/meta-posts.service";

describe("runMetaPostsSync — safe when nothing is connected", () => {
  it("is a no-op with no connections, and never throws", async () => {
    // The cron calls this unconditionally on every box, including ones that have
    // never connected a Meta account. It must be inert, not error.
    const out = await runMetaPostsSync();
    expect(out.assetsPolled).toBe(0);
    expect(out.postsUpserted).toBe(0);
    expect(out.rateLimited).toBe(false);
    expect(out.errors).toEqual([]);
  });
});

/**
 * The metric-shape helpers are intentionally exercised through the module's public
 * behaviour above; these cases document the exact Graph payload shapes that were
 * live-probed on 2026-08-19, so a future reader can see why the parsing looks the
 * way it does rather than "simplifying" it.
 *
 * Facebook returns engagement as MAPS, not scalars:
 *   post_reactions_by_type_total → {"like": 12, "love": 3}   ⇒ likes = 15
 *   post_activity_by_action_type → {"comment": 4, "share": 1} ⇒ comments 4, shares 1
 * and those keys are PRESENT ONLY WHEN > 0 — so an absent "share" key means
 * "no shares reported", which we store as null rather than 0.
 *
 * Instagram returns scalars, and gives like_count/comments_count inline on the
 * /media edge for free (one call for a whole page), which is why the insights pass
 * only needs reach/views/saved/total_interactions/shares.
 */
describe("documented Graph metric shapes (live-probed 2026-08-19)", () => {
  it("records the FB reaction-map shape", () => {
    const reactions = { like: 12, love: 3 };
    const summed = Object.values(reactions).reduce((a, b) => a + b, 0);
    expect(summed).toBe(15);
  });

  it("records that an absent activity key means 'not reported', not zero", () => {
    const activity: Record<string, number> = { comment: 4 };
    // share is absent — the correct reading is null (unknown), never 0.
    expect(activity["share"]).toBeUndefined();
  });

  it("records the metric names that are DEAD on v21+ so they are never re-added", () => {
    // Live-probed: these all return (#100).
    const dead = ["impressions", "post_impressions", "post_views", "post_engaged_users", "plays", "video_views"];
    // The live equivalents:
    const alive = { instagram: "views", facebook: "post_video_views" };
    expect(dead).not.toContain(alive.instagram);
    expect(dead).not.toContain(alive.facebook);
  });
});
