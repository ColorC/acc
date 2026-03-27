import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { SearchEngine } from "../search/index.js";

export interface HistoryEntry {
  group: string;
  command: string;
  options: Record<string, unknown>;
  timestamp: number;
}

export interface BatchDef {
  batch_id: string;
  commands: string[];
  trigger_tokens: string[];
  trigger_embedding?: number[];
  usage_count: number;
}

export class BatchEngine {
  private batchesDir: string;
  private historyDir: string;

  constructor(private searchEngine?: SearchEngine | null) {
    const baseDir = join(homedir(), ".acc", "batches");
    this.batchesDir = join(baseDir, "saved");
    this.historyDir = join(baseDir, "history");
  }

  /**
   * 记录一次执行。如果是同一 Session 内极短时间调用的第 3 次及以上，
   * 提取为批处理并保存，清空记录。
   */
  async record(sessionId: string | undefined, group: string, command: string, options: Record<string, unknown>): Promise<void> {
    if (!sessionId) return;
    mkdirSync(this.historyDir, { recursive: true });
    const hPath = join(this.historyDir, `session_${sessionId}.json`);
    
    let history: HistoryEntry[] = [];
    try {
       history = JSON.parse(readFileSync(hPath, "utf-8"));
    } catch { 
       // ignore
    }

    history.push({ group, command, options, timestamp: Date.now() });

    // 只保留最近 30 分钟内的命令
    history = history.filter(h => Date.now() - h.timestamp < 30 * 60 * 1000);

    if (history.length >= 3) {
      await this.createBatchFromHistory(history);
      history = []; // 归档后清空
    }
    
    writeFileSync(hPath, JSON.stringify(history, null, 2), "utf-8");
  }

  private async createBatchFromHistory(history: HistoryEntry[]): Promise<void> {
    const batchId = `auto-batch-${randomUUID().slice(0, 6)}`;
    const commands = history.map(h => {
       const args = Object.entries(h.options).map(([k, v]) => {
           if (typeof v === 'boolean') return v ? `--${k}` : '';
           return `--${k} "${v}"`;
       }).filter(Boolean).join(" ");
       return `acc ${h.group} ${h.command} ${args}`.trim();
    });

    const trigger_tokens = Array.from(new Set(history.flatMap(h => [h.group, h.command])));
    
    let trigger_embedding: number[] | undefined = undefined;
    if (this.searchEngine) {
       // 将该序列的所有操作特征拼起来生成特征向量
       const summaryText = history.map(h => `${h.group} ${h.command}`).join(" ");
       trigger_embedding = await this.searchEngine.getEmbedding(summaryText);
    }

    const batch: BatchDef = {
       batch_id: batchId,
       commands,
       trigger_tokens,
       trigger_embedding,
       usage_count: 0
    };

    mkdirSync(this.batchesDir, { recursive: true });
    writeFileSync(join(this.batchesDir, `${batchId}.json`), JSON.stringify(batch, null, 2), "utf-8");
  }

  /**
   * 利用已有向量相似度计算，从所有储存的批处理中寻找最匹配意图的 Batch
   */
  async recommendBatches(queryVector: number[]): Promise<{ batch: BatchDef; score: number }[]> {
    try {
      if (!existsSync(this.batchesDir)) return [];
      const files = readdirSync(this.batchesDir).filter(f => f.endsWith('.json'));
      const results: { batch: BatchDef; score: number }[] = [];

      for (const file of files) {
        const batch: BatchDef = JSON.parse(readFileSync(join(this.batchesDir, file), "utf-8"));
        if (batch.trigger_embedding && queryVector) {
          const score = this.cosineSimilarity(queryVector, batch.trigger_embedding);
          if (score > 0.4) {
            results.push({ batch, score: score + Math.log(batch.usage_count + 1) * 0.1 });
          }
        }
      }

      return results.sort((a, b) => b.score - a.score).slice(0, 2);
    } catch {
      return [];
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
