/**
 * Script Adapter — 将 shell 脚本注册为 CLI 命令
 *
 * 对应架构文档 Layer 2 的 Script 部分。
 *
 * 跨平台支持:
 *   Windows: .ps1 (PowerShell), .bat, .cmd
 *   Linux/macOS: .sh, .bash (需要可执行权限)
 *
 * 参数传递:
 *   Linux/macOS: 环境变量 $varname
 *   Windows PS1: 具名参数 -ParamName value（需脚本 param() 块）
 *   Windows BAT:  环境变量 %varname%
 *
 * 注释格式示例（Linux）:
 *   #!/bin/bash
 *   #ACC: summary: "同步数据库备份"
 *   #ACC: param: name=target type=string required=true desc="目标路径"
 *   #ACC: param: name=verbose type=boolean desc="详细输出"
 *
 * 注释格式示例（Windows PS1）:
 *   #ACC: summary: "同步数据库备份"
 *   #ACC: param: name=target type=string required=true desc="目标路径"
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { spawn } from "node:child_process";
import { platform } from "node:os";
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

    return runScript(script, args);
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
  /** 脚本文件扩展名，如 .sh / .ps1 / .bat */
  ext: string;
}

// ─── 平台检测 ───

/** Windows 接受的脚本扩展名 */
const WIN_SCRIPT_EXTS = new Set([".ps1", ".bat", ".cmd"]);
/** Linux/macOS 接受的脚本扩展名 */
const POSIX_SCRIPT_EXTS = new Set([".sh", ".bash", ""]);

/**
 * 判断该扩展名在当前平台是否是合法脚本。
 * Windows: .ps1 .bat .cmd
 * Linux/macOS: .sh .bash（无扩展名也允许，常见可执行文件）
 */
function isPlatformScript(ext: string): boolean {
  if (platform() === "win32") return WIN_SCRIPT_EXTS.has(ext);
  return POSIX_SCRIPT_EXTS.has(ext);
}

/**
 * 检查 Linux/macOS 下文件是否设置了执行位。
 * Windows 下跳过（POSIX X_OK 无意义）。
 */
function isExecutable(fullPath: string, _stat: import("node:fs").Stats): boolean {
  if (platform() === "win32") return true; // Windows 靠扩展名判断，不检查权限位
  // 检查 stat mode 的执行位（owner/group/other 任一有 x 即可）
  const mode = Number(_stat.mode);
  return (mode & 0o111) !== 0;
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

      // 跳过声明文件
      const ext = extname(entry).toLowerCase();
      if (ext === ".yaml" || ext === ".yml" || ext === ".json") continue;

      // 平台脚本过滤
      if (!isPlatformScript(ext)) continue;

      // 检查执行权限（仅 Linux/macOS）
      if (!isExecutable(fullPath, stat)) continue;

      // 解析脚本注释
      const content = readFileSync(fullPath, "utf-8");
      const meta = parseScriptMeta(content);
      const name = basename(entry, ext).replace(/[^a-zA-Z0-9_-]/g, "_");

      scripts.set(name, {
        name,
        path: fullPath,
        summary: meta.summary || `Script: ${name}`,
        params: meta.params,
        ext,
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

/**
 * 生成平台对应的 spawn 参数。
 * - Linux/macOS (.sh/.bash): 直接 spawn，通过环境变量传参（$varname）
 * - Windows PS1: powershell.exe -ExecutionPolicy Bypass -File <path> -Param value ...
 * - Windows BAT/CMD: cmd.exe /c <path>，通过环境变量传参（%varname%）
 */
function buildSpawnArgs(
  scriptPath: string,
  ext: string,
  args: Record<string, unknown>
): { command: string; spawnArgs: string[]; useEnv: boolean } {
  if (platform() !== "win32") {
    return { command: scriptPath, spawnArgs: [], useEnv: true };
  }

  if (ext === ".ps1") {
    // PowerShell: -Key value 具名参数
    const params: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === false) continue;
      params.push(`-${key}`);
      if (value !== true) params.push(String(value));
    }
    return {
      command: "powershell.exe",
      spawnArgs: ["-ExecutionPolicy", "Bypass", "-File", scriptPath, ...params],
      useEnv: false,
    };
  }

  // .bat / .cmd: cmd /c，通过环境变量传参
  return {
    command: "cmd.exe",
    spawnArgs: ["/c", scriptPath],
    useEnv: true,
  };
}

function runScript(
  scriptInfo: ScriptInfo,
  args: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const { command, spawnArgs, useEnv } = buildSpawnArgs(
      scriptInfo.path,
      scriptInfo.ext,
      args
    );

    // 环境变量参数传递（Linux/macOS + Windows BAT）
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env as Record<string, string>)) {
      env[k] = v;
    }
    if (useEnv) {
      for (const [key, value] of Object.entries(args)) {
        if (value !== undefined && value !== false) {
          env[key] = value === true ? "1" : String(value);
        }
      }
    }

    const child = spawn(command, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: { toString(): string }) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: { toString(): string }) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: Error) => {
      reject(new Error(`Script execution error: ${err.message}`));
    });

    child.on("close", (code: number | null) => {
      if (code !== 0) {
        reject(
          new Error(
            `Script exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
          )
        );
      } else {
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
