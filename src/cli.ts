/**
 * ACC — Agentic CLI Center
 *
 * 把任何来源的 Agent 工具统一转换为 bash CLI。
 * 让模型用 --help 自然发现工具，而不是携带几万字符的 JSON schema。
 *
 * Usage:
 *   acc --help                          # 展示所有 group
 *   acc <group> --help                  # 展示 group 下的 command
 *   acc <group> <command> --help        # 展示完整参数说明
 *   acc <group> <command> [--k v ...]   # 执行工具
 */

import { Command } from "commander";
import { Registry } from "./registry/index.js";
import { ConnectionPool } from "./pool.js";
import { bootstrap, shutdown } from "./bootstrap.js";
import type { ToolEntry, ParamDef } from "./types.js";

const VERSION = "0.1.0";

/**
 * 创建 ACC 主程序，从 Registry 动态生成子命令。
 */
export function createProgram(
  registry: Registry,
  pool: ConnectionPool
): Command {
  const program = new Command();

  program
    .name("acc")
    .version(VERSION)
    .description(
      "Agentic CLI Center — 把任何来源的 Agent 工具统一转换为 bash CLI"
    );

  // ─── 为每个 group 创建子命令 ───
  const groups = registry.listGroups();

  if (groups.length === 0) {
    program.addHelpText("after", () => {
      return "\n  No tools registered. Configure tools in acc-registry.yaml.";
    });
  } else {
    for (const groupName of groups.sort()) {
      const tools = registry.listByGroup(groupName);
      const groupCmd = new Command(groupName).description(
        `${tools.length} command(s) available`
      );

      for (const tool of tools) {
        const toolCmd = createToolCommand(tool, pool);
        groupCmd.addCommand(toolCmd);
      }

      program.addCommand(groupCmd);
    }

    // 顶层 help 追加 group 摘要
    program.addHelpText("after", () => {
      const lines = ["\nRegistered groups:"];
      for (const g of groups.sort()) {
        const tools = registry.listByGroup(g);
        const summaries = tools
          .slice(0, 3)
          .map((t) => t.command)
          .join(", ");
        const more = tools.length > 3 ? `, +${tools.length - 3} more` : "";
        lines.push(
          `  ${g.padEnd(16)} ${tools.length} cmd(s): ${summaries}${more}`
        );
      }
      lines.push(`\nRun 'acc <group> --help' to see commands in a group.`);
      return lines.join("\n");
    });
  }

  return program;
}

/**
 * 为单个 ToolEntry 创建 Commander 子命令。
 * 工具调用通过 Connection Pool 分发。
 */
function createToolCommand(tool: ToolEntry, pool: ConnectionPool): Command {
  const cmd = new Command(tool.command).description(tool.summary);

  // 从 ParamDef 生成 CLI 选项
  for (const param of tool.params) {
    const flag = buildFlag(param);
    if (param.required) {
      cmd.requiredOption(flag, param.description, param.defaultValue as string);
    } else {
      cmd.option(flag, param.description, param.defaultValue as string);
    }
  }

  // 执行动作 — 通过连接池调用
  cmd.action(async (options: Record<string, unknown>) => {
    try {
      const result = await pool.call(
        tool.adapter.sourceName,
        tool.command,
        options
      );
      outputResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const usageHint = formatUsage(tool);

      // 区分错误类型
      if (isUserError(msg)) {
        console.error(`ERROR: ${msg}`);
        console.error(usageHint);
        process.exit(2); // 用户参数错误
      } else {
        console.error(`ERROR: ${msg}`);
        console.error(usageHint);
        process.exit(1); // 后端/系统错误
      }
    }
  });

  return cmd;
}

// ─── 错误处理 ───

/**
 * 生成 Usage 提示（错误时附在 stderr）。
 * 借鉴 lazy-mcp: 错误响应内附 schema，帮助模型自我纠正。
 */
function formatUsage(tool: ToolEntry): string {
  const params = tool.params
    .map((p) => {
      const req = p.required ? "(required)" : "(optional)";
      return `  --${p.name} <${p.type}>  ${p.description} ${req}`;
    })
    .join("\n");

  return `\nUsage: acc ${tool.group} ${tool.command} [options]\n\nOptions:\n${params || "  (no parameters)"}`;
}

/**
 * 判断是否为用户参数错误（vs 后端错误）。
 */
function isUserError(msg: string): boolean {
  const patterns = [
    "missing required",
    "invalid",
    "not found",
    "unknown option",
    "expected",
  ];
  const lower = msg.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

// ─── 工具函数 ───

function buildFlag(param: ParamDef): string {
  if (param.type === "boolean") {
    return `--${param.name}`;
  }
  return `--${param.name} <${param.type}>`;
}

function outputResult(result: unknown): void {
  if (result === null || result === undefined) return;

  // MCP callTool 返回 { content: [...] } 格式
  if (typeof result === "object" && "content" in (result as object)) {
    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    for (const item of content) {
      if (item.type === "text" && item.text) {
        console.log(item.text);
      } else {
        console.log(JSON.stringify(item, null, 2));
      }
    }
    return;
  }

  if (typeof result === "string") {
    console.log(result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

// ─── 主入口 ───
async function main(): Promise<void> {
  const { registry, pool } = await bootstrap();

  const program = createProgram(registry, pool);

  // cleanup handler
  const cleanup = async () => {
    await shutdown(pool);
  };

  process.on("SIGINT", () => { cleanup().finally(() => process.exit(130)); });
  process.on("SIGTERM", () => { cleanup().finally(() => process.exit(143)); });

  // exitOverride: 拦截 Commander 的 help/version 退出
  program.exitOverride();

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (
      err instanceof Error &&
      "exitCode" in err &&
      (err as { exitCode: number }).exitCode === 0
    ) {
      await cleanup();
      process.exit(0);
    }
    await cleanup();
    process.exit(1);
  }

  await cleanup();
}

// 只在作为 CLI 直接执行时运行，被 vitest import 时不触发
const isCLI =
  process.argv[1]?.endsWith("cli.js") ||
  process.argv[1]?.endsWith("cli");

if (isCLI) {
  main().catch(async (err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
