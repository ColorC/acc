import { describe, it, expect, beforeEach, vi } from "vitest";
import { SearchEngine, tokenize } from "../src/search/index.js";
import type { ToolEntry } from "../src/types.js";

describe("SearchEngine Tokenizer", () => {
  it("should split by non-alphanumeric characters", () => {
    expect(tokenize("feishu_doc")).toEqual(["feishu", "doc"]);
    expect(tokenize("kg-query")).toEqual(["kg", "query"]);
    expect(tokenize("my.custom.tool")).toEqual(["my", "custom", "tool"]);
  });

  it("should ignore single characters to reduce noise", () => {
    expect(tokenize("test_a_file")).toEqual(["test", "file"]);
    expect(tokenize("a")).toEqual([]);
  });

  it("should normalize to lowercase", () => {
    expect(tokenize("FeiShu_Doc")).toEqual(["feishu", "doc"]);
  });
});

describe("SearchEngine", () => {
  let search: SearchEngine;

  const mockTools: ToolEntry[] = [
    {
      group: "feishu",
      command: "doc",
      publicName: "feishu/doc",
      summary: "Sync feishu document to local",
      description: "Full desc",
      params: [],
      adapter: { type: "script", sourceName: "local" },
      enabled: true,
    },
    {
      group: "kg",
      command: "import",
      publicName: "kg/import",
      summary: "Import knowledge graph data",
      description: "Full desc",
      params: [],
      adapter: { type: "mcp", sourceName: "remote" },
      enabled: true,
    },
    {
      group: "util",
      command: "base64",
      publicName: "util/base64",
      summary: "Encode or decode base64 strings",
      description: "Full desc",
      params: [],
      adapter: { type: "script", sourceName: "local" },
      enabled: true,
    },
  ];

  beforeEach(async () => {
    search = new SearchEngine();
    await search.buildIndex(mockTools);
  });

  it("should return top result for exact match", async () => {
    const results = await search.query("feishu");
    expect(results).toHaveLength(1);
    expect(results[0].entry.publicName).toBe("feishu/doc");
  });

  it("should rank exact matches higher than partial matches", async () => {
    // Add another tool containing 'feishu' in summary
    await search.buildIndex([
      ...mockTools,
      {
        group: "other",
        command: "sync",
        publicName: "other/sync",
        summary: "Sync data similarly to feishu/doc",
        description: "",
        params: [],
        adapter: { type: "script", sourceName: "local" },
        enabled: true,
      },
    ]);

    const results = await search.query("feishu");
    expect(results).toHaveLength(2);
    // feishu/doc should be first because group/command exact token match gets more points
    expect(results[0].entry.publicName).toBe("feishu/doc");
    expect(results[1].entry.publicName).toBe("other/sync");
  });

  it("should apply Levenshtein tolerance for typos (token length >= 4)", async () => {
    // fieshu is a typo for feishu
    const results = await search.query("fieshu");
    expect(results).toHaveLength(1);
    expect(results[0].entry.publicName).toBe("feishu/doc");
    // Typo score is 0.5, exact score is 3
    expect(results[0].score).toBeLessThan(3);
  });

  it("should use LRU cache for identical queries", async () => {
    const results1 = await search.query("doc");
    expect(results1).toHaveLength(1);

    // Modify index without calling buildIndex (which clears cache)
    search.getIndex().push({
      group: "fake",
      command: "doc",
      publicName: "fake/doc",
      summary: "Fake doc",
      tokens: ["fake", "doc"],
    });

    // Should still return cached result
    const results2 = await search.query("doc");
    expect(results2).toHaveLength(1);
  });

  it("should incorporate frequency scores if provided", async () => {
    const freqScores = new Map<string, number>();
    freqScores.set("other/sync", 10.0); // very high score

    await search.buildIndex([
      ...mockTools,
      {
        group: "other",
        command: "sync",
        publicName: "other/sync",
        summary: "Sync feishu document", // has feishu
        description: "",
        params: [],
        adapter: { type: "script", sourceName: "local" },
        enabled: true,
      },
    ]);

    // Usually feishu/doc would win because group exact match = 3 points
    // But other/sync has a +10 freq score
    const results = await search.query("feishu", 10, freqScores);
    expect(results[0].entry.publicName).toBe("other/sync");
    expect(results[1].entry.publicName).toBe("feishu/doc");
  });
});

