/**
 * Config Loader — 加载并解析 acc-registry.yaml
 *
 * 支持从以下位置查找配置文件（优先级从高到低）：
 * 1. ACC_CONFIG 环境变量指定的路径
 * 2. 当前工作目录下的 acc-registry.yaml
 * 3. ~/.config/acc/registry.yaml
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { AccConfig } from "../types.js";

const DEFAULT_CONFIG_NAME = "acc-registry.yaml";
const XDG_CONFIG_PATH = join(homedir(), ".config", "acc", "registry.yaml");

/**
 * 查找配置文件路径。如果找不到，返回 null。
 */
export function findConfigPath(): string | null {
  // 1. 环境变量优先
  const envPath = process.env.ACC_CONFIG;
  if (envPath) {
    const resolved = resolve(envPath);
    if (existsSync(resolved)) return resolved;
    // 环境变量指定了但文件不存在，直接报错
    throw new Error(`ACC_CONFIG points to "${envPath}" but file does not exist.`);
  }

  // 2. 当前目录
  const cwdPath = resolve(DEFAULT_CONFIG_NAME);
  if (existsSync(cwdPath)) return cwdPath;

  // 3. XDG config
  if (existsSync(XDG_CONFIG_PATH)) return XDG_CONFIG_PATH;

  return null;
}

/**
 * 加载并解析配置文件。
 * 如果配置文件不存在，返回空配置（零工具模式）。
 */
export function loadConfig(configPath?: string): AccConfig {
  const path = configPath ?? findConfigPath();

  if (!path) {
    // 无配置文件，返回空配置
    return { sources: [] };
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw) as AccConfig;

  // 基础校验
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid config file: ${path}`);
  }

  if (!Array.isArray(parsed.sources)) {
    parsed.sources = [];
  }

  return parsed;
}
