import { describe, it, expect } from "vitest";
import { isFollowerCorrectionArtifact } from "../src/services/account-growth.service";

describe("isFollowerCorrectionArtifact", () => {
  it("suppresses the negative stale→real collapse (existing behavior)", () => {
    expect(isFollowerCorrectionArtifact(-99)).toBe(true);
    expect(isFollowerCorrectionArtifact(-90)).toBe(true);
  });
  it("suppresses garbage tiny-baseline positive spikes (the '89' 2→59K = +2,963,850% case)", () => {
    expect(isFollowerCorrectionArtifact(2963850)).toBe(true);
  });
  it("suppresses the oscillation correction (Total Filmi 10,900↔46,300 = +324.8%)", () => {
    expect(isFollowerCorrectionArtifact(325)).toBe(true);
  });
  it("KEEPS legitimate growth (Paparazzi +1% on a 15M base)", () => {
    expect(isFollowerCorrectionArtifact(1)).toBe(false);
    expect(isFollowerCorrectionArtifact(15)).toBe(false); // Pap Hq +14.9%, real
  });
  it("keeps null deltaPct as non-artifact (no baseline → nothing to correct)", () => {
    expect(isFollowerCorrectionArtifact(null)).toBe(false);
  });
});
