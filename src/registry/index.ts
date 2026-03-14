/**
 * Registry — 管理所有注册工具的元数据
 *
 * 对应架构文档 Layer 1。
 */

import type { ToolEntry } from "../types.js";

export class Registry {
  private tools: Map<string, ToolEntry> = new Map();
  private aliases: Map<string, string> = new Map(); // alias → "group/command"

  /**
   * 注册一个工具到 registry。
   * 冲突时 warn + skip，不覆盖已注册工具。
   */
  register(entry: ToolEntry): void {
    const key = `${entry.group}/${entry.command}`;
    if (this.tools.has(key)) {
      console.warn(
        `[acc] Warning: tool "${key}" already registered, skipping duplicate.`
      );
      return;
    }
    this.tools.set(key, entry);
  }

  /**
   * 注册别名。
   * alias → group/command 的映射。
   */
  registerAlias(alias: string, group: string, command: string): void {
    const target = `${group}/${command}`;
    if (!this.tools.has(target)) {
      console.warn(
        `[acc] Warning: alias "${alias}" → "${target}" target not found, skipping.`
      );
      return;
    }
    this.aliases.set(alias, target);
  }

  /**
   * 通过 group + command 查找工具。
   * 如果直接查找失败，尝试通过 alias 查找。
   */
  resolve(group: string, command?: string): ToolEntry | undefined {
    // 直接查找
    if (command) {
      const direct = this.tools.get(`${group}/${command}`);
      if (direct) return direct;
    }

    // alias 查找：group 可能是 alias 名
    const aliasTarget = this.aliases.get(group);
    if (aliasTarget) {
      return this.tools.get(aliasTarget);
    }

    return undefined;
  }

  /**
   * 列出所有注册的工具。
   */
  list(): ToolEntry[] {
    return Array.from(this.tools.values());
  }

  /**
   * 列出所有 group 名称。
   */
  listGroups(): string[] {
    const groups = new Set<string>();
    for (const entry of this.tools.values()) {
      groups.add(entry.group);
    }
    return Array.from(groups);
  }

  /**
   * 列出指定 group 下的所有工具。
   */
  listByGroup(group: string): ToolEntry[] {
    return this.list().filter((entry) => entry.group === group);
  }

  /**
   * 注册工具总数。
   */
  get size(): number {
    return this.tools.size;
  }
}
