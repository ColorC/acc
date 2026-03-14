/**
 * Adapter 基础接口
 *
 * 对应架构文档 Layer 2。
 * 各 adapter（MCP、Script、Custom）实现此接口。
 * Phase 0: 只导出接口，Phase 1 开始实现 MCP adapter。
 */

export type { Adapter, RawToolDef, AdapterType, AdapterRef } from "../types.js";
