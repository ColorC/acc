/**
 * ACC 核心类型定义
 * 来自 ARCHITECTURE.md 的接口设计
 */

// ─── 参数定义 ───

export interface ParamDef {
  /** 参数名（CLI flag 名） */
  name: string;
  /** 参数类型 */
  type: "string" | "number" | "boolean";
  /** 是否必填 */
  required: boolean;
  /** 一句话描述 */
  description: string;
  /** 默认值 */
  defaultValue?: unknown;
}

// ─── Adapter 引用 ───

export interface AdapterRef {
  /** 适配器类型 */
  type: AdapterType;
  /** 数据源名称（对应 acc-registry.yaml 中的 source name） */
  sourceName: string;
}

export type AdapterType =
  | "mcp"
  | "openai-fn"
  | "anthropic-tool"
  | "script"
  | "custom";

// ─── 工具注册条目 ───

export interface ToolEntry {
  /** 分组名，如 "feishu" */
  group: string;
  /** 命令名，如 "doc" */
  command: string;
  /** 公开名：group/command 格式，如 "feishu/doc" */
  publicName: string;
  /** 一句话摘要（≤ 140 字符） */
  summary: string;
  /** 完整描述 */
  description: string;
  /** CLI 参数定义 */
  params: ParamDef[];
  /** 指向实际执行器 */
  adapter: AdapterRef;
  /** 是否启用 */
  enabled: boolean;
}

// ─── Adapter 接口 ───

export interface RawToolDef {
  /** 原始工具名 */
  name: string;
  /** 描述 */
  description?: string;
  /** 参数 schema（各 adapter 自行解析） */
  inputSchema?: Record<string, unknown>;
}

export interface Adapter {
  /** 适配器类型 */
  readonly type: AdapterType;
  /** 建立连接 */
  connect(): Promise<void>;
  /** 列出所有工具 */
  listTools(): Promise<RawToolDef[]>;
  /** 调用工具 */
  call(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  /** 关闭连接 */
  close(): Promise<void>;
}

// ─── 配置文件格式 ───

export interface AccConfig {
  settings?: AccSettings;
  sources: SourceConfig[];
  aliases?: Record<string, string>;
}

export interface AccSettings {
  maxConcurrentConnections?: number;
  idleTimeoutMs?: number;
  features?: FeatureFlags;
}

export interface FeatureFlags {
  dynamicHelp?: boolean;
  search?: boolean;
  batch?: boolean;
  taxonomy?: boolean;
  embedding?: boolean;
}

export type SourceConfig =
  | McpSourceConfig
  | ScriptSourceConfig
  | CustomSourceConfig;

export interface McpSourceConfig {
  type: "mcp";
  name: string;
  group: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
}

export interface ScriptSourceConfig {
  type: "script";
  name: string;
  group: string;
  path: string;
}

export interface CustomSourceConfig {
  type: "custom";
  name: string;
  config: string;
}
