import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { UsageTracker } from "../src/stats/usage.js";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("UsageTracker", () => {
  let tempDir: string;
  let usage: UsageTracker;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "acc-test-"));
    usage = new UsageTracker(undefined, undefined, tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should record usage and calculate score", () => {
    expect(usage.getScore("feishu", "doc")).toBe(0);

    usage.record("feishu", "doc");
    const score1 = usage.getScore("feishu", "doc");
    expect(score1).toBeGreaterThan(0); // log(2) * 2

    usage.record("feishu", "doc");
    const score2 = usage.getScore("feishu", "doc");
    expect(score2).toBeGreaterThan(score1); // log(3) * 2
  });

  it("should return top N tools", () => {
    usage.record("feishu", "doc");
    usage.record("feishu", "doc");
    usage.record("feishu", "doc");

    usage.record("kg", "query");
    usage.record("kg", "query");

    usage.record("util", "base64");

    const top = usage.getTopN(2);
    expect(top).toHaveLength(2);
    expect(top[0].command).toBe("doc");
    expect(top[1].command).toBe("query");
  });

  it("should apply different weights for session and agent", () => {
    const isolated = new UsageTracker("s1", "a1", tempDir);
    isolated.record("ai", "chat"); // writes to global, a1, and s1

    const scoreFull = isolated.getScore("ai", "chat");
    
    // Test that a different session under same agent only sees global + agent
    const diffSession = new UsageTracker("s2", "a1", tempDir);
    const scoreAgent = diffSession.getScore("ai", "chat");
    
    // Test that a totally different session/agent only sees global
    const diffGlobal = new UsageTracker("s2", "a2", tempDir);
    const scoreGlobal = diffGlobal.getScore("ai", "chat");

    expect(scoreFull).toBeGreaterThan(scoreAgent);
    expect(scoreAgent).toBeGreaterThan(scoreGlobal);
    expect(scoreGlobal).toBeGreaterThan(0);
  });

  it("should return score map", () => {
    usage.record("feishu", "doc");
    usage.record("kg", "query");

    const map = usage.getScoreMap();
    expect(map.size).toBe(2);
    expect(map.get("feishu/doc")).toBeGreaterThan(0);
    expect(map.get("kg/query")).toBeGreaterThan(0);
  });

  it("should persist and reload data", () => {
    usage.record("feishu", "doc");
    usage.record("feishu", "doc");
    
    // Create a new instance pointing to same dir
    const newUsage = new UsageTracker(undefined, undefined, tempDir);
    
    expect(newUsage.getScore("feishu", "doc")).toBe(usage.getScore("feishu", "doc"));
    const top = newUsage.getTopN(1);
    expect(top[0].command).toBe("doc");
  });
});
