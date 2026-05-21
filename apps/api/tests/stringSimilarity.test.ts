import { describe, it, expect } from "vitest";
import { stringSimilarity } from "@dashmani/shared";

describe("stringSimilarity", () => {
  it("returns 1 for identical strings", () => {
    expect(stringSimilarity("Alice", "Alice")).toBe(1);
  });

  it("is case-insensitive", () => {
    expect(stringSimilarity("alice", "ALICE")).toBe(1);
  });

  it("returns high score for one-char typo", () => {
    expect(stringSimilarity("Priyanshu", "Priyansh")).toBeGreaterThan(0.85);
  });

  it("returns low score for completely different strings", () => {
    expect(stringSimilarity("Alice", "Zubair")).toBeLessThan(0.5);
  });

  it("returns 1 for two empty strings", () => {
    expect(stringSimilarity("", "")).toBe(1);
  });

  it("email local-part similarity catches near-duplicate emails", () => {
    const score = stringSimilarity("tabish.m", "tabish.mukaddam");
    expect(score).toBeGreaterThan(0.5);
  });
});
