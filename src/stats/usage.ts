/**
 * UsageTracker — 工具调用频率统计（完全隔离的三级权重版）
 *
 * 功能：
 *   - 分级记录：global, agent/<id>, session/<id>
 *   - 分级打分： Session 分 × 3 + Agent 分 × 1.5 + Global 分 × 1.0 (log(count+1))
 *   - 持久化到 ~/.acc/usage/<namespace>.json
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// 频率分权重
const WEIGHT_SESSION = 3.0;
const WEIGHT_AGENT = 1.5;
const WEIGHT_GLOBAL = 1.0;

// 最多保留的工具记录数
const MAX_RECORDS = 500;

export interface ToolStat {
  group: string;
  command: string;
  count: number;
  lastUsed: number;
}

interface PersistData {
  version: 1;
  stats: Record<string, ToolStat>;
}

export class UsageTracker {
  private globalStats = new Map<string, ToolStat>();
  private agentStats = new Map<string, ToolStat>();
  private sessionStats = new Map<string, ToolStat>();

  private baseDir: string;
  private dirtyGlobal = false;
  private dirtyAgent = false;
  private dirtySession = false;

  constructor(
    private sessionId?: string,
    private agentId?: string,
    dataDir?: string
  ) {
    this.baseDir = dataDir ?? join(homedir(), ".acc", "usage");
    this.globalStats = this.load("global");
    if (this.agentId) this.agentStats = this.load(`agent_${this.agentId}`);
    if (this.sessionId) this.sessionStats = this.load(`session_${this.sessionId}`);
  }

  private increment(map: Map<string, ToolStat>, group: string, command: string) {
    const key = `${group}/${command}`;
    const existing = map.get(key);
    if (existing) {
      existing.count++;
      existing.lastUsed = Date.now();
    } else {
      map.set(key, { group, command, count: 1, lastUsed: Date.now() });
    }
  }

  record(group: string, command: string): void {
    this.increment(this.globalStats, group, command);
    this.dirtyGlobal = true;

    if (this.agentId) {
      this.increment(this.agentStats, group, command);
      this.dirtyAgent = true;
    }
    if (this.sessionId) {
      this.increment(this.sessionStats, group, command);
      this.dirtySession = true;
    }

    this.save();
  }

  getScore(group: string, command: string): number {
    const key = `${group}/${command}`;
    let score = 0;

    const gStat = this.globalStats.get(key);
    if (gStat) score += Math.log(gStat.count + 1) * WEIGHT_GLOBAL;

    const aStat = this.agentStats.get(key);
    if (aStat) score += Math.log(aStat.count + 1) * WEIGHT_AGENT;

    const sStat = this.sessionStats.get(key);
    if (sStat) score += Math.log(sStat.count + 1) * WEIGHT_SESSION;

    return score;
  }

  getTopN(n: number): ToolStat[] {
    const allKeys = new Set([
      ...this.globalStats.keys(),
      ...this.agentStats.keys(),
      ...this.sessionStats.keys()
    ]);

    const aggregated = Array.from(allKeys).map(key => {
       const [group, command] = key.split("/");
       const score = this.getScore(group, command);
       return { group, command, score };
    });

    aggregated.sort((a, b) => b.score - a.score);
    return aggregated.slice(0, n).map(r => ({
       group: r.group,
       command: r.command,
       count: 0,
       lastUsed: Date.now()
    }));
  }

  getScoreMap(): Map<string, number> {
    const allKeys = new Set([
      ...this.globalStats.keys(),
      ...this.agentStats.keys(),
      ...this.sessionStats.keys()
    ]);
    const map = new Map<string, number>();
    for (const key of allKeys) {
      const [group, command] = key.split("/");
      const score = this.getScore(group, command);
      if (score > 0) map.set(key, score);
    }
    return map;
  }

  // ─── 持久化 ───

  private getPath(namespace: string): string {
    return join(this.baseDir, `${namespace}.json`);
  }

  private load(namespace: string): Map<string, ToolStat> {
    const map = new Map<string, ToolStat>();
    try {
      const p = this.getPath(namespace);
      const raw = readFileSync(p, "utf-8");
      const data = JSON.parse(raw) as PersistData;
      if (data.version === 1 && data.stats) {
        for (const [key, stat] of Object.entries(data.stats)) {
          map.set(key, stat);
        }
      }
    } catch {
      // 文件不存在则返回空
    }
    return map;
  }

  private persist(namespace: string, mapToSave: Map<string, ToolStat>): Map<string, ToolStat> {
    try {
      const p = this.getPath(namespace);
      mkdirSync(dirname(p), { recursive: true });

      let statsToSave = mapToSave;
      if (statsToSave.size > MAX_RECORDS) {
        const sorted = Array.from(statsToSave.entries())
          .sort(([, a], [, b]) => b.count - a.count)
          .slice(0, MAX_RECORDS);
        statsToSave = new Map(sorted);
      }

      const data: PersistData = {
        version: 1,
        stats: Object.fromEntries(statsToSave),
      };
      writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
      return statsToSave;
    } catch {
      console.error(`[acc] Warning: failed to save usage stats for ${namespace}`);
      return mapToSave;
    }
  }

  private save(): void {
    if (this.dirtyGlobal) {
      this.globalStats = this.persist("global", this.globalStats);
      this.dirtyGlobal = false;
    }
    if (this.dirtyAgent && this.agentId) {
      this.agentStats = this.persist(`agent_${this.agentId}`, this.agentStats);
      this.dirtyAgent = false;
    }
    if (this.dirtySession && this.sessionId) {
      this.sessionStats = this.persist(`session_${this.sessionId}`, this.sessionStats);
      this.dirtySession = false;
    }
  }
}
