/**
 * Script Adapter — 将 shell 脚本注册为 CLI 命令
 *
 * 对应架构文档 Layer 2 的 Script 部分。
 *
 * 支持两种方式声明参数：
 * 1. 脚本文件头部注释解析（#ACC: 开头）
 * 2. 同名 .yaml 声明文件回退
 *
 * 注释格式示例:
 *   #!/bin/bash
 *   #ACC: summary: "同步数据库备份"
 *   #ACC: param: name=target type=string required=true desc="目标路径"
 *   #ACC: param: name=verbose type=boolean desc="详细输出"
 */

import { readdirSync, readFileSync, statSync, accessSync, constants } from "node:fs";
import { join, basename, extname } from "node:path";
import { spawn } from "node:child_process";
import type {
  Adapter,
  RawToolDef,
  ScriptSourceConfig,
  ToolEntry,
  ParamDef,
} from "../types.js";

export class ScriptAdapter implements Adapter {
  readonly type = "script" as const;
  private scripts: Map<string, ScriptInfo> = new Map();

  constructor(public config: ScriptSourceConfig) {}

  async connect(): Promise<void> {
    // 扫描目录，找到所有可执行脚本
    this.scripts = scanScripts(this.config.path);
  }

  async listTools(): Promise<RawToolDef[]> {
    return Array.from(this.scripts.values()).map((info) => ({
      name: info.name,
      description: info.summary,
      inputSchema: paramsToSchema(info.params),
    }));
  }

  async call(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const script = this.scripts.get(toolName);
    if (!script) {
      throw new Error(`Script "${toolName}" not found in ${this.config.path}`);
    }

    return runScript(script.path, args);
  }

  async close(): Promise<void> {
    // 脚本不需要持久连接
    this.scripts.clear();
  }

  /**
   * 将扫描到的脚本转换为 ToolEntry[]。
   */
  toToolEntries(rawTools: RawToolDef[]): ToolEntry[] {
    return rawTools.map((raw) => {
      const script = this.scripts.get(raw.name);
      return {
        group: this.config.group,
        command: raw.name,
        publicName: `${this.config.group}/${raw.name}`,
        summary: truncate(raw.description ?? "", 140),
        description: raw.description ?? "",
        params: script?.params ?? [],
        adapter: { type: "script" as const, sourceName: this.config.name },
        enabled: true,
      };
    });
  }
}

// ─── 内部类型 ───

interface ScriptInfo {
  name: string;
  path: string;
  summary: string;
  params: ParamDef[];
}

// ─── 扫描脚本 ───

function scanScripts(dirPath: string): Map<string, ScriptInfo> {
  const scripts = new Map<string, ScriptInfo>();

  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    console.error(`[acc] Warning: cannot read script directory "${dirPath}"`);
    return scripts;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry);

    try {
      const stat = statSync(fullPath);
      if (!stat.isFile()) continue;

      // 跳过 .yaml/.yml（这些是声明文件，不是脚本）
      const ext = extname(entry).toLowerCase();
      if (ext === ".yaml" || ext === ".yml") continue;

      // 检查可执行权限
      try {
        accessSync(fullPath, constants.X_OK);
      } catch {
        continue; // 不可执行，跳过
      }

      // 解析脚本注释
      const content = readFileSync(fullPath, "utf-8");
      const meta = parseScriptMeta(content);
      const name = basename(entry, ext).replace(/[^a-zA-Z0-9_-]/g, "_");

      scripts.set(name, {
        name,
        path: fullPath,
        summary: meta.summary || `Script: ${name}`,
        params: meta.params,
      });
    } catch {
      // 单个脚本解析失败不阻塞
    }
  }

  return scripts;
}

// ─── 解析 #ACC: 注释 ───

interface ScriptMeta {
  summary: string;
  params: ParamDef[];
}

function parseScriptMeta(content: string): ScriptMeta {
  const lines = content.split("\n").slice(0, 30); // 只看前 30 行
  let summary = "";
  const params: ParamDef[] = [];

  for (const line of lines) {
    const match = line.match(/^#\s*ACC:\s*(.+)/i);
    if (!match) continue;

    const directive = match[1].trim();

    // summary: "..."
    const summaryMatch = directive.match(/^summary:\s*["']?(.+?)["']?\s*$/i);
    if (summaryMatch) {
      summary = summaryMatch[1];
      continue;
    }

    // param: name=xxx type=xxx required=true desc="..."
    const paramMatch = directive.match(/^param:\s*(.+)/i);
    if (paramMatch) {
      const param = parseParamDirective(paramMatch[1]);
      if (param) params.push(param);
    }
  }

  return { summary, params };
}

function parseParamDirective(raw: string): ParamDef | null {
  const kv: Record<string, string> = {};
  // 匹配 key=value 或 key="value with spaces"
  const regex = /(\w+)=(?:"([^"]*)"|([\S]+))/g;
  let m;
  while ((m = regex.exec(raw)) !== null) {
    kv[m[1]] = m[2] ?? m[3];
  }

  if (!kv.name) return null;

  return {
    name: kv.name,
    type: (kv.type as "string" | "number" | "boolean") ?? "string",
    required: kv.required === "true",
    description: kv.desc ?? kv.description ?? "",
    defaultValue: kv.default,
  };
}

// ─── 执行脚本 ───

function runScript(
  scriptPath: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // 将 args 作为环境变量传递（bash 脚本用 $varname 引用）
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined && value !== false) {
        env[key] = value === true ? "1" : String(value);
      }
    }

    const child = spawn(scriptPath, [], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`Script execution error: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Script exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
          )
        );
      } else {
        // 模拟 MCP 的 content 格式以保持输出一致
        resolve({
          content: [{ type: "text", text: stdout }],
        });
      }
    });
  });
}

// ─── 工具函数 ───

function paramsToSchema(
  params: ParamDef[]
): Record<string, unknown> | undefined {
  if (params.length === 0) return undefined;

  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const p of params) {
    properties[p.name] = {
      type: p.type === "number" ? "number" : p.type === "boolean" ? "boolean" : "string",
      description: p.description,
    };
    if (p.required) required.push(p.name);
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}
