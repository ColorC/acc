/**
 * MCP Adapter — 连接 MCP server 并转换工具为 ToolEntry
 *
 * 对应架构文档 Layer 2 的 MCP 部分。
 * Phase 1: 只支持 stdio transport，每次调用直接建连→调用→保持连接。
 * Phase 2 再加 Connection Pool。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { platform } from "node:os";
import type {
  Adapter,
  RawToolDef,
  McpSourceConfig,
  ToolEntry,
  ParamDef,
} from "../types.js";

/** Windows 下常见的命令需要 .cmd 后缀才能通过 spawn 找到 */
const WIN_CMD_WRAPPERS = new Set(["npx", "npm", "pnpm", "yarn", "node"]);

/**
 * 在 Windows 上，如果命令是无扩展名的 npm 相关工具，自动补充 .cmd。
 * Linux/macOS 上直接返回原始命令。
 */
function resolveCommand(cmd: string): string {
  if (platform() !== "win32") return cmd;
  // 如果已有扩展名（.exe .cmd .bat）则不处理
  if (/\.[a-z]+$/i.test(cmd)) return cmd;
  const base = cmd.split(/[\\/]/).pop() ?? cmd;
  if (WIN_CMD_WRAPPERS.has(base)) return `${cmd}.cmd`;
  return cmd;
}

export class McpAdapter implements Adapter {
  readonly type = "mcp" as const;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor(private config: McpSourceConfig) {
    if (config.transport !== "stdio") {
      throw new Error(
        `MCP adapter only supports stdio transport in Phase 1, got: ${config.transport}`
      );
    }
    if (!config.command) {
      throw new Error(
        `MCP source "${config.name}" with stdio transport requires a "command" field.`
      );
    }
  }

  async connect(): Promise<void> {
    if (this.client) return; // 已连接

    this.transport = new StdioClientTransport({
      command: resolveCommand(this.config.command!),
      args: this.config.args ?? [],
    });

    this.client = new Client({
      name: "acc",
      version: "0.1.0",
    });

    await this.client.connect(this.transport);
  }

  async listTools(): Promise<RawToolDef[]> {
    if (!this.client) {
      throw new Error("MCP adapter not connected. Call connect() first.");
    }

    const result = await this.client.listTools();
    return (result.tools ?? []).map((tool: {
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
    }));
  }

  async call(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    if (!this.client) {
      throw new Error("MCP adapter not connected. Call connect() first.");
    }

    const result = await this.client.callTool({
      name: toolName,
      arguments: args,
    });

    return result;
  }

  async close(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
      this.client = null;
    }
  }

  /**
   * 将 MCP 工具的 inputSchema (JSON Schema) 转换为 ParamDef[]。
   */
  static schemaToParams(inputSchema?: Record<string, unknown>): ParamDef[] {
    if (!inputSchema) return [];

    const properties = inputSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!properties) return [];

    const required = (inputSchema.required as string[]) ?? [];

    return Object.entries(properties).map(([name, prop]) => ({
      name,
      type: mapJsonSchemaType(prop.type as string),
      required: required.includes(name),
      description: (prop.description as string) ?? "",
      defaultValue: prop.default,
    }));
  }

  /**
   * 将 RawToolDef[] 转换为 ToolEntry[]，绑定到指定的 group。
   */
  toToolEntries(rawTools: RawToolDef[]): ToolEntry[] {
    return rawTools.map((raw) => ({
      group: this.config.group,
      command: raw.name,
      publicName: `${this.config.group}/${raw.name}`,
      summary: truncate(raw.description ?? "", 140),
      description: raw.description ?? "",
      params: McpAdapter.schemaToParams(raw.inputSchema),
      adapter: { type: "mcp" as const, sourceName: this.config.name },
      enabled: true,
    }));
  }
}

// ─── 辅助函数 ───

function mapJsonSchemaType(
  jsonType: string | undefined
): "string" | "number" | "boolean" {
  switch (jsonType) {
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}
