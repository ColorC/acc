import { describe, it, expect } from "vitest";
import { createProgram } from "../src/cli.js";
import { Registry } from "../src/registry/index.js";
import { ConnectionPool } from "../src/pool.js";
import type { ToolEntry } from "../src/types.js";

// ─── 辅助 ───

function makeToolEntry(
  group: string,
  command: string,
  params: ToolEntry["params"] = [],
  sourceName = "test"
): ToolEntry {
  return {
    group,
    command,
    publicName: `${group}/${command}`,
    summary: `${group} ${command} tool`,
    description: `A test ${group} ${command} tool`,
    params,
    adapter: { type: "mcp", sourceName },
    enabled: true,
  };
}

// ─── CLI Tests ───

describe("acc CLI", () => {
  it("should create program without errors", () => {
    const registry = new Registry();
    const pool = new ConnectionPool();
    const program = createProgram(registry, pool);
    expect(program.name()).toBe("acc");
  });

  it("should show version", () => {
    const registry = new Registry();
    const pool = new ConnectionPool();
    const program = createProgram(registry, pool);
    expect(program.version()).toBe("0.1.0");
  });

  it("should generate group subcommands from registry", () => {
    const registry = new Registry();
    const pool = new ConnectionPool();
    registry.register(makeToolEntry("feishu", "doc"));
    registry.register(makeToolEntry("kg", "query"));

    const program = createProgram(registry, pool);
    const commands = program.commands.map((c) => c.name());

    expect(commands).toContain("feishu");
    expect(commands).toContain("kg");
  });

  it("should generate tool subcommands under group", () => {
    const registry = new Registry();
    const pool = new ConnectionPool();
    registry.register(makeToolEntry("feishu", "doc"));
    registry.register(makeToolEntry("feishu", "search"));

    const program = createProgram(registry, pool);
    const feishuCmd = program.commands.find((c) => c.name() === "feishu");

    expect(feishuCmd).toBeDefined();
    const toolCmds = feishuCmd!.commands.map((c) => c.name());
    expect(toolCmds).toContain("doc");
    expect(toolCmds).toContain("search");
  });

  it("should generate CLI options from params", () => {
    const registry = new Registry();
    const pool = new ConnectionPool();
    registry.register(
      makeToolEntry("feishu", "doc", [
        {
          name: "token",
          type: "string",
          required: true,
          description: "Access token",
        },
        {
          name: "verbose",
          type: "boolean",
          required: false,
          description: "Verbose output",
        },
      ])
    );

    const program = createProgram(registry, pool);
    const feishuCmd = program.commands.find((c) => c.name() === "feishu");
    const docCmd = feishuCmd!.commands.find((c) => c.name() === "doc");

    expect(docCmd).toBeDefined();
    const opts = docCmd!.options.map((o) => o.long);
    expect(opts).toContain("--token");
    expect(opts).toContain("--verbose");
  });
});

// ─── Registry Tests ───

describe("Registry", () => {
  it("should register and resolve a tool", () => {
    const registry = new Registry();
    registry.register(makeToolEntry("test", "hello"));

    const tool = registry.resolve("test", "hello");
    expect(tool).toBeDefined();
    expect(tool?.publicName).toBe("test/hello");
  });

  it("should skip duplicate registrations with warning", () => {
    const registry = new Registry();
    const entry = makeToolEntry("test", "hello");

    registry.register(entry);
    registry.register(entry);

    expect(registry.size).toBe(1);
  });

  it("should list groups", () => {
    const registry = new Registry();
    registry.register(makeToolEntry("feishu", "doc"));
    registry.register(makeToolEntry("kg", "query"));

    const groups = registry.listGroups();
    expect(groups).toContain("feishu");
    expect(groups).toContain("kg");
    expect(groups).toHaveLength(2);
  });

  it("should list tools by group", () => {
    const registry = new Registry();
    registry.register(makeToolEntry("feishu", "doc"));
    registry.register(makeToolEntry("feishu", "search"));
    registry.register(makeToolEntry("kg", "query"));

    const feishuTools = registry.listByGroup("feishu");
    expect(feishuTools).toHaveLength(2);
    expect(feishuTools.map((t) => t.command)).toContain("doc");
    expect(feishuTools.map((t) => t.command)).toContain("search");
  });

  it("should resolve alias", () => {
    const registry = new Registry();
    registry.register(makeToolEntry("feishu", "doc"));
    registry.registerAlias("doc", "feishu", "doc");

    const tool = registry.resolve("doc");
    expect(tool).toBeDefined();
    expect(tool?.publicName).toBe("feishu/doc");
  });

  it("should skip alias if target not found", () => {
    const registry = new Registry();
    // no tool registered, alias should warn + skip
    registry.registerAlias("doc", "feishu", "doc");
    expect(registry.resolve("doc")).toBeUndefined();
  });
});

// ─── Connection Pool Tests ───

describe("ConnectionPool", () => {
  it("should register and track adapters", () => {
    const pool = new ConnectionPool();
    const mockAdapter = {
      type: "mcp" as const,
      connect: async () => {},
      listTools: async () => [],
      call: async () => ({}),
      close: async () => {},
    };

    pool.register("test-server", mockAdapter);
    expect(pool.size).toBe(1);
    expect(pool.connectedCount).toBe(0); // 懒连接，未实际连接
  });

  it("should lazy connect on acquire", async () => {
    let connected = false;
    const mockAdapter = {
      type: "mcp" as const,
      connect: async () => { connected = true; },
      listTools: async () => [],
      call: async () => ({}),
      close: async () => { connected = false; },
    };

    const pool = new ConnectionPool();
    pool.register("test-server", mockAdapter);

    expect(connected).toBe(false);
    await pool.acquire("test-server");
    expect(connected).toBe(true);

    await pool.closeAll();
  });

  it("should call through pool", async () => {
    let callArgs: { name: string; args: Record<string, unknown> } | null = null;
    const mockAdapter = {
      type: "mcp" as const,
      connect: async () => {},
      listTools: async () => [],
      call: async (name: string, args: Record<string, unknown>) => {
        callArgs = { name, args };
        return { content: [{ type: "text", text: "ok" }] };
      },
      close: async () => {},
    };

    const pool = new ConnectionPool();
    pool.register("test-server", mockAdapter);

    const result = await pool.call("test-server", "list_dir", { path: "/tmp" });
    expect(callArgs).toEqual({ name: "list_dir", args: { path: "/tmp" } });
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });

    await pool.closeAll();
  });

  it("should close all connections", async () => {
    let closed = false;
    const mockAdapter = {
      type: "mcp" as const,
      connect: async () => {},
      listTools: async () => [],
      call: async () => ({}),
      close: async () => { closed = true; },
    };

    const pool = new ConnectionPool();
    pool.register("test-server", mockAdapter);
    await pool.acquire("test-server");

    await pool.closeAll();
    expect(closed).toBe(true);
    expect(pool.size).toBe(0);
  });
});

// ─── MCP Adapter Tests ───

describe("McpAdapter.schemaToParams", () => {
  it("should convert JSON Schema to ParamDef[]", async () => {
    const { McpAdapter } = await import("../src/adapters/mcp.js");

    const schema = {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        recursive: { type: "boolean", description: "Recurse into subdirectories" },
        depth: { type: "integer", description: "Max depth" },
      },
      required: ["path"],
    };

    const params = McpAdapter.schemaToParams(schema);

    expect(params).toHaveLength(3);
    expect(params[0]).toMatchObject({
      name: "path",
      type: "string",
      required: true,
    });
    expect(params[1]).toMatchObject({
      name: "recursive",
      type: "boolean",
      required: false,
    });
    expect(params[2]).toMatchObject({
      name: "depth",
      type: "number",
      required: false,
    });
  });

  it("should handle missing schema", async () => {
    const { McpAdapter } = await import("../src/adapters/mcp.js");
    expect(McpAdapter.schemaToParams(undefined)).toEqual([]);
    expect(McpAdapter.schemaToParams({})).toEqual([]);
  });
});
