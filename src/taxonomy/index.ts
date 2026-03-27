import type { SearchEngine } from "../search/index.js";
import type { IndexEntry } from "../types.js";

interface Cluster {
  id: number;
  items: IndexEntry[];
  vector: number[];
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

// 距离越小越近 (0 = 相同, 1 = 正交)
function cosineDistance(a: number[], b: number[]): number {
  return 1.0 - cosineSimilarity(a, b);
}

export class TaxonomyEngine {
  constructor(private searchEngine: SearchEngine) {}

  /**
   * 自动无监督聚类推荐（Agglomerative Clustering）
   * @param threshold 相似度合并阈值，默认 0.4 (1.0 - 0.6) 表示余弦相似度必须 > 0.6 才会被合成一组
   */
  public suggestReorganization(threshold = 0.4): Map<string, string[]> {
    const index = this.searchEngine.getIndex();
    
    // 过滤出有 vector 的条目，将它们初始化为独立的 cluster
    let clusters: Cluster[] = index
      .filter((e) => e.vector)
      .map((e, idx) => ({
        id: idx,
        items: [e],
        vector: e.vector!
      }));

    if (clusters.length === 0) return new Map();

    // 凝聚式递推合并
    while (clusters.length > 1) {
      let minDist = Infinity;
      let mergeA = -1;
      let mergeB = -1;

      // O(N^2) 寻找最近距离
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const dist = cosineDistance(clusters[i].vector, clusters[j].vector);
          if (dist < minDist) {
            minDist = dist;
            mergeA = i;
            mergeB = j;
          }
        }
      }

      // 如果全场最近的两个依然大于阈值（即缺乏关联），停止聚合
      if (minDist > threshold) break;

      // 执行合并 A 和 B
      const a = clusters[mergeA];
      const b = clusters[mergeB];
      
      // 平均池化更新中心向量
      const mergedVector = a.vector.map((val, idx) => (val + b.vector[idx]) / 2.0);

      clusters.push({
        id: a.id,
        items: [...a.items, ...b.items],
        vector: mergedVector
      });

      // 从原数组摘除（注意按降序摘除，避免错位）
      clusters.splice(mergeB, 1);
      clusters.splice(mergeA, 1);
    }

    // 为每个 cluster 起名字，输出推荐表
    const suggested = new Map<string, string[]>();
    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      if (cluster.items.length === 1) {
        // 独狼保持原始 group
        const item = cluster.items[0];
        const groupList = suggested.get(item.group) || [];
        groupList.push(`${item.group}/${item.command}`);
        suggested.set(item.group, groupList);
      } else {
        // 多成员簇，根据 Token 词频投票起新 Group 名
        const tokenFreq = new Map<string, number>();
        for (const item of cluster.items) {
          // 只取 group/command 和 publicName 里的核心词，避免 summary 引入介词
          const coreTokens = [...item.tokens.slice(0, 2)]; 
          for (const t of coreTokens) {
            tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1);
          }
        }

        let bestToken = "misc";
        let maxF = 0;
        for (const [t, f] of tokenFreq.entries()) {
          if (f > maxF && t.length > 2) {
            maxF = f;
            bestToken = t;
          }
        }

        const groupName = `auto_${bestToken}`;
        const groupList = suggested.get(groupName) || [];
        groupList.push(...cluster.items.map(m => `${m.group}/${m.command}`));
        suggested.set(groupName, groupList);
      }
    }

    return suggested;
  }
}
