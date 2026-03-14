/**
 * Bootstrap — 启动流程
 *
 * 1. 加载 acc-registry.yaml
 * 2. 为每个 source 创建 adapter
 * 3. 注册到 Connection Pool（懒连接）
 * 4. 连接 adapter，获取工具列表
 * 5. 将工具注册到 Registry
 * 6. 处理 aliases
 */

import { loadConfig } from "./config/index.js";
import { Registry } from "./registry/index.js";
import { ConnectionPool } from "./pool.js";
import { McpAdapter } from "./adapters/mcp.js";
import { ScriptAdapter } from "./adapters/script.js";
import type { Adapter, McpSourceConfig, ScriptSourceConfig } from "./types.js";

export interface BootstrapResult {
  registry: Registry;
  pool: ConnectionPool;
  adapters: Adapter[];
}

/**
 * 初始化 ACC：加载配置 → 创建 adapters → 注册到 pool → 注册工具。
 */
export async function bootstrap(
  configPath?: string
): Promise<BootstrapResult> {
  const config = loadConfig(configPath);
  const registry = new Registry();
  const pool = new ConnectionPool();
  const adapters: Adapter[] = [];

  for (const source of config.sources) {
    try {
      switch (source.type) {
        case "mcp": {
          const adapter = new McpAdapter(source as McpSourceConfig);

          // 连接并获取工具列表
          await adapter.connect();
          const rawTools = await adapter.listTools();
          const entries = adapter.toToolEntries(rawTools);

          for (const entry of entries) {
            registry.register(entry);
          }

          // 注册到连接池管理
          pool.register(source.name, adapter);
          adapters.push(adapter);

          console.error(
            `[acc] Loaded ${entries.length} tool(s) from MCP source "${source.name}"`
          );
          break;
        }

        case "script": {
          const adapter = new ScriptAdapter(source as ScriptSourceConfig);
          await adapter.connect();
          const rawTools = await adapter.listTools();
          const entries = adapter.toToolEntries(rawTools);

          for (const entry of entries) {
            registry.register(entry);
          }

          pool.register(source.name, adapter);
          adapters.push(adapter);

          console.error(
            `[acc] Loaded ${entries.length} tool(s) from script source "${source.name}"`
          );
          break;
        }

        case "custom":
          console.error(
            `[acc] Warning: custom adapter not yet implemented, skipping source "${source.name}"`
          );
          break;

        default:
          console.error(
            `[acc] Warning: unknown source type "${(source as { type: string }).type}", skipping`
          );
      }
    } catch (err) {
      console.error(
        `[acc] Error loading source "${source.name}": ${err instanceof Error ? err.message : String(err)}`
      );
      // 单个 source 失败不阻塞其他 source
    }
  }

  // 处理 aliases
  if (config.aliases) {
    for (const [publicName, alias] of Object.entries(config.aliases)) {
      const [group, command] = publicName.split("/");
      if (!group || !command) {
        console.error(`[acc] Warning: invalid alias key "${publicName}", expected "group/command" format`);
        continue;
      }
      registry.registerAlias(alias, group, command);
    }
  }

  return { registry, pool, adapters };
}

/**
 * 优雅关闭所有连接。
 */
export async function shutdown(pool: ConnectionPool): Promise<void> {
  await pool.closeAll();
}
