/**
 * Search Engine — 工具搜索与语义索引
 * 采用全本地的 Hybrid Search（混合搜索）：
 * 1. Semantic Embedding（基于 Transformers.js 和 ONNX 量化模型）
 * 2. 启发式词汇匹配（前缀、精等字眼匹配）
 * 3. 动态频率计分加权
 */

import { pipeline, env, type FeatureExtractionPipeline } from "@xenova/transformers";
import type { IndexEntry, SearchResult, ToolEntry } from "../types.js";

// 配置 transformers 以确保在 Node 环境可运行
// @ts-ignore
env.allowLocalModels = true;

// ─── LRU Cache ───

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class LRUCache<T> {
  private map = new Map<string, CacheEntry<T>>();

  constructor(private maxEntries: number, private ttlMs: number) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== 0 && Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key);
    if (this.map.size >= this.maxEntries) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, {
      value,
      expiresAt: this.ttlMs === 0 ? 0 : Date.now() + this.ttlMs,
    });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

// ─── Tokenizer & Math ───

const TOKENIZE_RE = /[^a-z0-9\s]/g;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(TOKENIZE_RE, " ")
    .split(/[\s_\-]+/)
    .filter((t) => t.length > 1);
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] 
        ? dp[i - 1][j - 1] 
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function minLevenshtein(qt: string, tokens: string[]): number {
  let min = Infinity;
  for (const t of tokens) {
    const d = levenshtein(qt, t);
    if (d < min) min = d;
  }
  return min;
}

function cosineSimilarity(a: number[], b: number[]): number {
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

// ─── 搜索引擎 ───

export class SearchEngine {
  private index: IndexEntry[] = [];
  private searchCache = new LRUCache<SearchResult[]>(128, 60_000);
  private schemaCache = new LRUCache<string[] | null>(256, 0);
  private vectorCache = new LRUCache<number[]>(1024, 0);
  private extractor: FeatureExtractionPipeline | null = null;
  private loadFailed = false;

  async initPipeline() {
    if (this.extractor || this.loadFailed) return;
    try {
      // 禁用本地日志并静默下载量化模型
      this.extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        quantized: true,
      });
    } catch (err) {
      console.warn("[acc] Warning: Failed to load ONNX embedding model (are you offline?). Falling back to keyword search.", err instanceof Error ? err.message : String(err));
      this.loadFailed = true;
    }
  }

  async getEmbedding(text: string): Promise<number[] | undefined> {
    if (!this.extractor) return undefined;
    const cached = this.vectorCache.get(text);
    if (cached) return cached;
    try {
      const output = await this.extractor(text, { pooling: 'mean', normalize: true });
      const vector = Array.from(output.data as Float32Array);
      this.vectorCache.set(text, vector);
      return vector;
    } catch {
      return undefined;
    }
  }

  async buildIndex(tools: ToolEntry[]): Promise<void> {
    await this.initPipeline();
    this.index = [];
    for (const tool of tools) {
      const featureText = `${tool.publicName} ${tool.summary} ${tool.description} ${tool.params.map(p => p.name).join(" ")}`;
      const vector = await this.getEmbedding(featureText);
      this.index.push({
        group: tool.group,
        command: tool.command,
        publicName: tool.publicName,
        summary: tool.summary,
        tokens: [
          ...tokenize(tool.group),
          ...tokenize(tool.command),
          ...tokenize(tool.summary),
          ...tokenize(tool.publicName),
        ],
        vector
      });
    }
    this.searchCache.clear();
    this.schemaCache.clear();
  }

  async query(
    query: string,
    maxResults = 10,
    freqScores?: Map<string, number>
  ): Promise<SearchResult[]> {
    const cacheKey = `${query}:${maxResults}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached && !freqScores) return cached;

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const queryVector = await this.getEmbedding(query);
    const results: SearchResult[] = [];

    for (const entry of this.index) {
      let score = this.computeKeywordScore(queryTokens, entry);

      if (queryVector && entry.vector) {
        const sim = cosineSimilarity(queryVector, entry.vector);
        if (sim > 0.3) {
          score += sim * 5.0; // 语义相似度大权重
        }
      }

      if (score <= 0) continue;

      if (freqScores) {
        const key = `${entry.group}/${entry.command}`;
        const freqScore = freqScores.get(key) ?? 0;
        score += freqScore;
      }

      results.push({ entry, score });
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, maxResults);

    if (!freqScores) {
      this.searchCache.set(cacheKey, top);
    }
    return top;
  }

  getIndex(): IndexEntry[] {
    return this.index;
  }

  get size(): number {
    return this.index.length;
  }

  private computeKeywordScore(queryTokens: string[], entry: IndexEntry): number {
    let score = 0;
    for (const qt of queryTokens) {
      if (entry.tokens.includes(qt)) {
        score += 3;
      } else if (entry.tokens.some((t) => t.startsWith(qt))) {
        score += 2;
      } else if (entry.tokens.some((t) => t.includes(qt))) {
        score += 1;
      } else if (entry.publicName.toLowerCase().includes(qt)) {
        score += 2;
      } else if (qt.length >= 4 && minLevenshtein(qt, entry.tokens) <= 2) {
        score += 0.5;
      }
    }
    return score;
  }

  getTokens(publicName: string): string[] | null {
    const cached = this.schemaCache.get(publicName);
    if (cached !== undefined) return cached;
    const entry = this.index.find((e) => e.publicName === publicName);
    const tokens = entry?.tokens ?? null;
    this.schemaCache.set(publicName, tokens);
    return tokens;
  }
}
