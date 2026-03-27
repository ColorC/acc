import { describe, it, expect } from "vitest";
import { Registry } from "../src/registry/index.js";
import type { ToolEntry } from "../src/types.js";
import { buildTopHelp } from "../src/cli.js";

// 用来生成 mock tool 的工具函数
function createTools(count: number): ToolEntry[] {
  const tools: ToolEntry[] = [];
  for (let i = 0; i < count; i++) {
    tools.push({
      group: i % 2 === 0 ? "groupA" : "groupB",
      command: `cmd${i}`,
      publicName: `${i % 2 === 0 ? "groupA" : "groupB"}/cmd${i}`,
      summary: `summary for tool ${i}`,
      description: `desc ${i}`,
      params: [
        { name: "p1", type: "string", required: true, description: "param 1" },
      ],
      adapter: { type: "script", sourceName: "local" },
      enabled: true,
    });
  }
  return tools;
}

describe("Dynamic Help", () => {
  it("should fully expand help when total tools <= 10", () => {
    const registry = new Registry();
    createTools(5).forEach((t) => registry.register(t));

    const helpText = buildTopHelp(registry, null, []);

    // 应该显示 group 名字
    expect(helpText).toContain("Group: groupA");
    expect(helpText).toContain("Group: groupB");
    
    // 应该显示参数详情 "--p1"
    expect(helpText).toContain("--p1");
    // 应该显示摘要
    expect(helpText).toContain("summary for tool 0");
  });

  it("should medium expand help when tools 11-30", () => {
    const registry = new Registry();
    createTools(20).forEach((t) => registry.register(t));

    const helpText = buildTopHelp(registry, null, []);

    // 应该显示 Group 和 command
    expect(helpText).toContain("Group: groupA");
    expect(helpText).toContain("cmd0");
    // 但是不应该展开参数 (完全展开时有 acc groupA cmd0 --p1)
    expect(helpText).not.toContain("--p1");
  });

  it("should minimal expand help when tools > 30", () => {
    const registry = new Registry();
    createTools(35).forEach((t) => registry.register(t));

    const helpText = buildTopHelp(registry, null, []);

    // 应该用 "18 cmd(s): cmd0, cmd2, cmd4, +15 more" 的格式
    expect(helpText).toContain("Group: groupA");
    expect(helpText).toContain("more");
    // 不应该存在参数展开
    expect(helpText).not.toContain("--p1");
  });
});

