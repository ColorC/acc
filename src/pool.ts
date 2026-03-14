/**
 * Connection Pool — 管理后端连接的生命周期
 *
 * 对应架构文档 Layer 3。
 *
 * 核心能力:
 * - 懒连接: 首次调用时才建连
 * - LRU 驱逐: 超过 MAX_CONCURRENT 时关闭最久未用的连接
 * - Idle TTL: 5 分钟无活动自动断连
 * - 重试: 只重试 transport 层错误，指数退避 + 随机抖动
 * - stdio mutex: 同一 server 的调用串行化
 */

import type { Adapter } from "./types.js";

// ─── 参数（来自架构文档，有实验基础） ───

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟
const CONNECT_TIMEOUT_MS = 15_000; // 建连 15s
const CALL_TIMEOUT_MS = 30_000; // 单次调用 30s
const MAX_CONCURRENT = 20; // 最多同时维持的连接
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8_000;

// 可重试的 transport 层错误
const RETRYABLE_ERRORS = [
  "EPIPE",
  "ECONNRESET",
  "ERR_IPC_CHANNEL_CLOSED",
  "Timeout",
  "ECONNREFUSED",
  "ETIMEDOUT",
];

const debug = process.env.ACC_LOG === "debug";

function log(msg: string): void {
  if (debug) console.error(`[acc:pool] ${msg}`);
}

// ─── 连接条目 ───

interface PoolEntry {
  /** adapter 对应的 source name（唯一标识） */
  key: string;
  /** 实际的 adapter 实例 */
  adapter: Adapter;
  /** 上次使用时间 */
  lastUsed: number;
  /** idle timeout 定时器 */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** 是否已连接 */
  connected: boolean;
  /** stdio mutex: 确保同一 server 串行调用 */
  mutex: Promise<void>;
}

// ─── 连接池 ───

export class ConnectionPool {
  /** Map 的插入顺序模拟 LRU（delete + re-set = 移到末尾） */
  private entries: Map<string, PoolEntry> = new Map();

  /**
   * 注册一个 adapter 到连接池，不立即建连（懒连接）。
   */
  register(key: string, adapter: Adapter): void {
    if (this.entries.has(key)) {
      log(`adapter "${key}" already registered, skipping`);
      return;
    }

    this.entries.set(key, {
      key,
      adapter,
      lastUsed: 0,
      idleTimer: null,
      connected: false,
      mutex: Promise.resolve(),
    });

    log(`registered adapter "${key}" (lazy, not connected)`);
  }

  /**
   * 获取一个已连接的 adapter。如果未连接，自动建连。
   */
  async acquire(key: string): Promise<Adapter> {
    const entry = this.entries.get(key);
    if (!entry) {
      throw new Error(`No adapter registered with key "${key}"`);
    }

    // 懒连接
    if (!entry.connected) {
      await this.connect(entry);
    }

    // 更新 LRU 位置（delete + re-set = 移到 Map 末尾）
    this.entries.delete(key);
    this.entries.set(key, entry);

    // 更新时间 + 重置 idle timer
    entry.lastUsed = Date.now();
    this.resetIdleTimer(entry);

    return entry.adapter;
  }

  /**
   * 通过连接池调用工具，带重试和超时。
   */
  async call(
    key: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const entry = this.entries.get(key);
    if (!entry) {
      throw new Error(`No adapter registered with key "${key}"`);
    }

    // stdio mutex: 同一 server 的调用排队等待
    const result = await this.withMutex(entry, async () => {
      return this.callWithRetry(entry, toolName, args);
    });

    return result;
  }

  /**
   * 关闭所有连接。
   */
  async closeAll(): Promise<void> {
    const closeTasks: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      closeTasks.push(this.closeEntry(entry));
    }
    await Promise.allSettled(closeTasks);
    this.entries.clear();
    log("all connections closed");
  }

  /**
   * 关闭指定连接。
   */
  async close(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry) {
      await this.closeEntry(entry);
      this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get connectedCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.connected) count++;
    }
    return count;
  }

  // ─── 内部方法 ───

  private async connect(entry: PoolEntry): Promise<void> {
    // 检查连接上限，需要的话驱逐最久未用的
    await this.evictIfNeeded();

    log(`connecting to "${entry.key}"...`);
    try {
      await withTimeout(entry.adapter.connect(), CONNECT_TIMEOUT_MS);
      entry.connected = true;
      entry.lastUsed = Date.now();
      this.resetIdleTimer(entry);
      log(`connected to "${entry.key}"`);
    } catch (err) {
      throw new Error(
        `Failed to connect to "${entry.key}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async callWithRetry(
    entry: PoolEntry,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // 确保已连接
        if (!entry.connected) {
          await this.connect(entry);
        }

        entry.lastUsed = Date.now();
        this.resetIdleTimer(entry);

        const result = await withTimeout(
          entry.adapter.call(toolName, args),
          CALL_TIMEOUT_MS
        );

        if (attempt > 0) {
          log(`call "${entry.key}/${toolName}" succeeded after ${attempt} retries`);
        }
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // 只重试 transport 层错误
        if (!isRetryable(lastError)) {
          throw lastError;
        }

        if (attempt < MAX_RETRIES) {
          const delayMs = retryDelay(attempt);
          log(
            `call "${entry.key}/${toolName}" failed (${lastError.message}), retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
          );

          // 标记断连，下次重试时会重新建连
          entry.connected = false;
          try {
            await entry.adapter.close();
          } catch {
            // 关闭失败忽略
          }

          await sleep(delayMs);
        }
      }
    }

    throw lastError ?? new Error("Unknown error");
  }

  private async evictIfNeeded(): Promise<void> {
    // 统计已连接的数量
    let connectedCount = 0;
    for (const entry of this.entries.values()) {
      if (entry.connected) connectedCount++;
    }

    // 如果没超限，不需要驱逐
    if (connectedCount < MAX_CONCURRENT) return;

    // Map 的第一个元素就是最久没被 re-set 的（LRU）
    for (const [key, entry] of this.entries) {
      if (entry.connected) {
        log(`evicting LRU connection "${key}" (lastUsed: ${entry.lastUsed})`);
        await this.closeEntry(entry);
        this.entries.delete(key);
        break; // 只驱逐一个
      }
    }
  }

  private resetIdleTimer(entry: PoolEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }

    const timer = setTimeout(async () => {
      if (entry.connected) {
        log(`idle timeout for "${entry.key}", closing`);
        await this.closeEntry(entry);
      }
    }, IDLE_TIMEOUT_MS);

    // timer.unref() 确保不阻止进程正常退出
    timer.unref();
    entry.idleTimer = timer;
  }

  private async closeEntry(entry: PoolEntry): Promise<void> {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (entry.connected) {
      try {
        await entry.adapter.close();
      } catch {
        // 关闭失败静默处理
      }
      entry.connected = false;
      log(`closed connection "${entry.key}"`);
    }
  }

  /**
   * stdio mutex: 同一 server 的调用串行化。
   * 不同 server 之间可以并发。
   */
  private async withMutex<T>(
    entry: PoolEntry,
    fn: () => Promise<T>
  ): Promise<T> {
    // 等待前一个调用完成
    const prev = entry.mutex;
    let resolve!: () => void;
    entry.mutex = new Promise<void>((r) => {
      resolve = r;
    });

    await prev;

    try {
      return await fn();
    } finally {
      resolve();
    }
  }
}

// ─── 工具函数 ───

function isRetryable(err: Error): boolean {
  const msg = err.message ?? "";
  return RETRYABLE_ERRORS.some((code) => msg.includes(code));
}

function retryDelay(attempt: number): number {
  // 指数退避 + 随机抖动
  const base = Math.min(RETRY_BASE_MS * Math.pow(2, attempt), RETRY_MAX_MS);
  const jitter = Math.random() * base * 0.3; // ±30% 抖动
  return Math.floor(base + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout")), ms);
    timer.unref();

    promise.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
