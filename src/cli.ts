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
import type { SearchEngine } from "./search/index.js";
import type { UsageTracker } from "./stats/usage.js";
import type { BatchEngine, BatchDef } from "./batch/engine.js";
import { TaxonomyEngine } from "./taxonomy/index.js";
import { Exporter } from "./export/index.js";
import type { ToolEntry, ParamDef, SearchResult } from "./types.js";

const VERSION = "0.1.0";

const DYNAMIC_HELP = process.env.ACC_DYNAMIC_HELP === "1";
const SEARCH_ENABLED = process.env.ACC_SEARCH === "1";

/**
 * 创建 ACC 主程序，从 Registry 动态生成子命令。
 */
export function createProgram(
  registry: Registry,
  pool: ConnectionPool,
  search: SearchEngine | null = null,
  usage: UsageTracker | null = null,
  topMatches: SearchResult[] = [],
  batch: BatchEngine | null = null,
  sessionId?: string,
  recommendedBatches: { batch: BatchDef; score: number }[] = []
): Command {
  const program = new Command();

  program
    .name("acc")
    .version(VERSION)
    .description(
      "Agentic CLI Center — 把任何来源的 Agent 工具统一转换为 bash CLI"
    );

  // ─── acc search <query>（Phase 3，ACC_SEARCH=1） ───
  if (SEARCH_ENABLED && search) {
    const searchCmd = new Command("search")
      .description("Search for tools by keyword")
      .argument("<query>", "Search query")
      .option("--json", "Output as JSON")
      .action(async (query: string, opts: { json?: boolean }) => {
        const freqScores = usage?.getScoreMap();
        const results = await search.query(query, 10, freqScores);
        if (results.length === 0) {
          console.log(`No tools found for: "${query}"`);
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(results.map((r) => ({
            publicName: r.entry.publicName,
            summary: r.entry.summary,
            score: r.score,
          })), null, 2));
        } else {
          console.log(`Search results for "${query}":\n`);
          for (const r of results) {
            console.log(`  ${r.entry.publicName.padEnd(24)} ${r.entry.summary}`);
          }
        }
      });
    // ─── Phase 4 Auto-Taxonomy 重组 ───
    const reorgCmd = new Command("reorganize")
      .description("Analyze tools and suggest new taxonomy via agglomerative clustering")
      .option("-t, --threshold <value>", "Clustering threshold (default: 0.4)", "0.4")
      .action(async (opts: { threshold: string }) => {
        console.log("Analyzing tool semantic vectors...");
        const engine = new TaxonomyEngine(search);
        const suggested = engine.suggestReorganization(parseFloat(opts.threshold));

        console.log("\n[Suggested Taxonomy Tree]:");
        let autoCount = 0;
        for (const [group, commands] of suggested) {
          if (group.startsWith("auto_")) autoCount++;
          console.log(`\n📦 Group: ${group} (${commands.length} tools)`);
          for (const c of commands) {
            console.log(`  └─ ${c.padEnd(30)}`);
          }
        }
        console.log(`\nFound ${autoCount} semantic meta-clusters. (Save logic pending Agent's interactive confirmation)`);
      });
    program.addCommand(reorgCmd);

    // ─── Phase 4 Schema 反向导出 ───
    const exportCmd = new Command("export")
      .description("Export registered tools as OpenAI or MCP JSON schema")
      .requiredOption("-f, --format <format>", "Export format (openai|mcp)")
      .action((opts: { format: string }) => {
        const exporter = new Exporter(registry);
        let out;
        if (opts.format.toLowerCase() === "openai") {
          out = exporter.exportOpenAI();
        } else if (opts.format.toLowerCase() === "mcp") {
          out = exporter.exportMCP();
        } else {
          console.error("Unknown format. Use 'openai' or 'mcp'.");
          process.exit(1);
        }
        console.log(JSON.stringify(out, null, 2));
      });
    program.addCommand(exportCmd);
  }

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
        const toolCmd = createToolCommand(tool, pool, usage, batch, sessionId);
        groupCmd.addCommand(toolCmd);
      }

      program.addCommand(groupCmd);
    }

    // ─── Phase 4 附加子命令 batch ───
    if (batch) {
       const batchGroup = new Command("batch").description("Batch execution engine");
       batchGroup.command("run <id>")
         .description("Run a saved batch")
         .action((id) => {
           console.log(`[Batch Engine] Running batch ${id}... (Please use individual piped commands manually for now)`);
         });
       program.addCommand(batchGroup);
    }

    // 顶层 help：动态弹性展开 or 静态 group 摘要
    program.addHelpText("after", (context: { error: boolean }) => {
      const intent = context.error ? undefined :
        process.argv.find((_, i) => process.argv[i - 1] === "--intent");
      return buildTopHelp(registry, usage, topMatches, intent, recommendedBatches);
    });
  }

  // 为顶层 help 追加 --intent 选项（动态 help 激活时）
  if (DYNAMIC_HELP) {
    program.option("--intent <text>", "Filter help by intent (semantic search)");
    program.option("--session <id>", "Session ID for frequency weighting");
    program.option("--agent <id>", "Agent ID for frequency weighting");
  }

  return program;
}

/**
 * 为单个 ToolEntry 创建 Commander 子命令。
 * 工具调用通过 Connection Pool 分发。
 */
function createToolCommand(
  tool: ToolEntry,
  pool: ConnectionPool,
  usage: UsageTracker | null = null,
  batch: BatchEngine | null = null,
  sessionId?: string
): Command {
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
      if (usage) {
        usage.record(tool.group, tool.command);
      }

      if (batch && sessionId) {
        await batch.record(sessionId, tool.group, tool.command, options);
      }
      
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
  const { registry, pool, search, usage, batch } = await bootstrap();

  const sessionIdx = process.argv.indexOf("--session");
  const sessionId = sessionIdx !== -1 ? process.argv[sessionIdx + 1] : undefined;

  let topMatches: SearchResult[] = [];
  let recommendedBatches: { batch: BatchDef; score: number }[] = [];
  
  if (DYNAMIC_HELP && search) {
    const intentIdx = process.argv.indexOf("--intent");
    const intent = intentIdx !== -1 ? process.argv[intentIdx + 1] : undefined;
    if (intent) {
      topMatches = await search.query(intent, 10, usage?.getScoreMap());
      if (batch) {
        const queryVector = await search.getEmbedding(intent);
        if (queryVector) {
          recommendedBatches = await batch.recommendBatches(queryVector);
        }
      }
    }
  }

  const program = createProgram(registry, pool, search, usage, topMatches, batch, sessionId, recommendedBatches);

  // cleanup handler
  const cleanup = async () => {
    await shutdown(pool);
  };

  process.on("SIGINT", () => { cleanup().finally(() => process.exit(130)); });
  process.on("SIGTERM", () => { cleanup().finally(() => process.exit(143)); });
  // Windows: Ctrl+C on PowerShell/CMD triggers SIGBREAK, not SIGTERM
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => { cleanup().finally(() => process.exit(143)); });
  }

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

// ─── 动态 Help ───

export function buildTopHelp(
  registry: Registry,
  usage: UsageTracker | null,
  topMatches: SearchResult[],
  intent?: string,
  recommendedBatches: { batch: BatchDef; score: number }[] = []
): string {
  const lines: string[] = ["\nRegistered Tools:"];
  
  if (recommendedBatches.length > 0) {
    lines.push(`\n  [Recommended Smart Batches]`);
    for (const b of recommendedBatches) {
       lines.push(`  acc batch run ${b.batch.batch_id}  (Score: ${b.score.toFixed(2)})`);
       lines.push(`    └─ Pipeline: ${b.batch.commands.map(c => c.split(" ")[2]).join(" -> ")}`);
    }
  }

  // 聚光灯：必须全展开呈现的命令
  const spotlightCmds = new Set<string>();
  
  if (intent && topMatches.length > 0) {
    lines.push(`\n  [Top Matches for intent "${intent}"]`);
    for (const r of topMatches) {
      const g = r.entry.group;
      const c = r.entry.command;
      spotlightCmds.add(`${g}/${c}`);
      
      const t = registry.resolve(g, c);
      if (t) {
        const params = t.params.map(p => `--${p.name}`).join(" ");
        lines.push(`  acc ${g} ${c} ${params}`.trimEnd());
        lines.push(`    └─ ${t.summary}`);
      }
    }
    lines.push(`\n  (Remaining tools follow baseline folding rules)`);
  } else if (intent) {
    lines.push(`\n  (No matches found for intent "${intent}")`);
  }

  // 加入 Top3 频率最高工具到聚光灯
  if (usage) {
    const top3 = usage.getTopN(3);
    for (const stat of top3) {
      spotlightCmds.add(`${stat.group}/${stat.command}`);
    }
  }

  const groups = registry.listGroups().sort();
  const totalTools = registry.list().length;

  for (const g of groups) {
    const tools = registry.listByGroup(g);
    
    // 弹性展开策略
    if (totalTools <= 10) {
      // 全局极简容量：完全展开（附带所有参数概览）
      lines.push(`\n  Group: ${g}`);
      for (const t of tools) {
        const params = t.params.map(p => `--${p.name}`).join(" ");
        lines.push(`    acc ${g} ${t.command} ${params}`.trimEnd());
        lines.push(`      └─ ${t.summary}`);
      }
    } else if (totalTools <= 30) {
      // 中等容量：按频率排序，隐藏参数（除非命中 spotlight）
      let sortedTools = tools;
      if (usage) {
        sortedTools = [...tools].sort((a, b) => 
          usage.getScore(b.group, b.command) - usage.getScore(a.group, a.command)
        );
      }
      lines.push(`\n  Group: ${g}`);
      for (const t of sortedTools) {
        if (spotlightCmds.has(`${t.group}/${t.command}`)) {
          // 常驻展现（包含参数）
          const params = t.params.map(p => `--${p.name}`).join(" ");
          lines.push(`    acc ${g} ${t.command} ${params}`.trimEnd());
          lines.push(`      └─ [⭐Freq] ${t.summary}`);
        } else {
          // 普通展现（无参数）
          lines.push(`    ${t.command.padEnd(20)} ${t.summary}`);
        }
      }
    } else {
      // 巨大容量：极简展开（只有 Group 和部分命令名），如果是 spotlight 则突破展示
      lines.push(`\n  Group: ${g}`);
      let hasSpotlight = false;
      
      for (const t of tools) {
        if (spotlightCmds.has(`${t.group}/${t.command}`)) {
          hasSpotlight = true;
          const params = t.params.map(p => `--${p.name}`).join(" ");
          lines.push(`    acc ${g} ${t.command} ${params}`.trimEnd());
          lines.push(`      └─ [★Top] ${t.summary}`);
        }
      }
      
      const normalCount = tools.filter(t => !spotlightCmds.has(`${t.group}/${t.command}`)).length;
      if (normalCount > 0) {
         if (hasSpotlight) {
            lines.push(`    ... plus ${normalCount} folded command(s)`);
         } else {
            const summaries = tools.slice(0, 3).map((t) => t.command).join(", ");
            const more = tools.length > 3 ? `, +${tools.length - 3} more` : "";
            lines.push(`    ${tools.length} cmd(s): ${summaries}${more}`);
         }
      }
    }
  }

  if (totalTools > 10) {
    if (spotlightCmds.size > 0 && totalTools > 30) {
       lines.push(`\n(★  means tool is expanded due to high frequency or intent match)`);
    }
    lines.push(`\nRun 'acc <group> --help' to see commands in a group.`);
  }

  return lines.join("\n");
}

if (isCLI) {
  main().catch(async (err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
