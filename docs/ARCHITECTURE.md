# Agentic CLI Center (ACC) — 架构设计文档

> 核心理念：把任何来源的 Agent 工具统一转换为 bash CLI 入口，让模型用 `--help` 自然发现工具，而不是在每轮对话里携带几万字符的 JSON schema。

---

## 1. 问题与目标

### 1.1 现状痛点

| 问题 | 表现 |
|------|------|
| Schema 膨胀 | 21 个工具 ≈ 15,000 字符 schema，每轮对话都要携带 |
| 注意力分散 | 工具越多，模型的选择精度越低 |
| 来源碎片化 | MCP、Function Calling、脚本各自一套发现方式 |
| 复用率为零 | Agent 每次都重新生成相同的复杂操作序列 |

### 1.2 核心指标（来自内部 PoC benchmark）

- Schema 字符数：15,000 → 3,700（75% 减少）
- 每轮 prompt tokens：~8,500 → ~6,200（27% 减少，8 轮对话均值）
- 节省比例随工具数线性增长（O(n) schema → O(1) CLI 入口）

### 1.3 设计目标

1. 统一入口：`acc <group> <command> [--params]`，替代所有工具的 function call schema
2. 渐进发现：Agent 先看 `--help` 摘要，需要时再展开详情，不需要提前加载全部
3. 工具无关：适配任何来源（MCP、OpenAI FnCall、Anthropic tool_use、脚本、自定义）
4. 实验可开关：所有高级特性都有 feature flag，基础功能不依赖实验特性

---

## 2. 系统边界

```
┌──────────────────────────────────────────────────────┐
│                  Agent (LLM)                          │
│  exec("acc feishu doc --token xxx")                  │
└─────────────────────┬────────────────────────────────┘
                      │  bash / exec tool
┌─────────────────────▼────────────────────────────────┐
│                  ACC 进程                             │
│                                                      │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐  │
│  │  Router  │  │ Help Gen  │  │  Batch Engine    │  │
│  │  (P0)    │  │  (P1)     │  │  (P2)            │  │
│  └────┬─────┘  └─────┬─────┘  └─────────┬────────┘  │
│       │               │                  │           │
│  ┌────▼───────────────▼──────────────────▼────────┐  │
│  │              Registry（工具索引）               │  │
│  │   MCP | FnCall | Script | Custom YAML          │  │
│  └──────────────────┬──────────────────────────────┘ │
│                     │                                 │
│  ┌──────────────────▼──────────────────────────────┐ │
│  │         Semantic Engine（可选，P1）              │ │
│  │   搜索索引 | 频率统计 | Embedding（可选）        │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────┬────────────────────────────────┘
                      │  dispatch
         ┌────────────┼────────────┐
         ▼            ▼            ▼
     MCP Server   Shell Cmd    HTTP API
```

---

## 3. 分层架构

### Layer 0：CLI 壳（P0，必须实现）

所有交互的统一入口，遵循 git/docker 范式。

```
acc --help                          # 展示所有 group
acc <group> --help                  # 展示 group 下的 command
acc <group> <command> --help        # 展示完整参数说明
acc <group> <command> [--k v ...]   # 执行工具
```

**实现约束：**
- 命令格式必须是 `acc <group> <command>`，两级固定，不允许三级
- `--help` 输出到 stdout，错误到 stderr
- 错误时附上正确用法：`ERROR: <msg>\nUsage: acc <group> <command> --param <type>`（借鉴 lazy-mcp：错误响应内附 schema，帮助模型自我纠正）

### Layer 1：Registry（P0，必须实现）

管理所有注册工具的元数据，是其他所有层的数据源。

```typescript
interface ToolEntry {
  group: string;          // "feishu"
  command: string;        // "doc"
  publicName: string;     // "feishu/doc"（serverName/toolName 格式，借鉴 nimble）
  summary: string;        // 一句话摘要（≤ 140 字符）
  description: string;    // 完整描述
  params: ParamDef[];     // CLI 参数定义
  adapter: AdapterRef;    // 指向实际执行器
  enabled: boolean;
}
```

**命名冲突处理（借鉴 nimble）：**
- 默认公开名：`serverName/toolName`
- 允许 alias 配置覆盖
- 冲突时不 crash，输出警告并 skip，不覆盖已注册工具

### Layer 2：Adapter Layer（P0，必须实现）

负责将各来源工具格式转换为统一的 `ToolEntry`，并实际分发调用。

```typescript
interface Adapter {
  type: "mcp" | "openai-fn" | "anthropic-tool" | "script" | "custom";
  connect(): Promise<void>;
  listTools(): Promise<RawToolDef[]>;
  call(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
```

**各 Adapter 实现要点：**

| 类型 | 参数来源 | 调用方式 |
|------|---------|---------|
| MCP | `tools[].inputSchema` → CLI flags | JSON-RPC `tools/call` |
| OpenAI FnCall | `functions[].parameters` → CLI flags | 用户提供 HTTP endpoint |
| Anthropic tool_use | `tools[].input_schema` → CLI flags | 同上 |
| Script | `--help` 输出解析 / 注释解析 / 手动声明 | `child_process.spawn` |
| Custom YAML | 声明式配置文件 | 配置中定义的 handler |

### Layer 3：Connection Pool（P0，必须实现）

管理后端连接的生命周期，直接采用 mcp-tool-search 的设计。

**关键参数（有实验基础的数值）：**

```typescript
const IDLE_TIMEOUT_MS  = 5 * 60 * 1000;  // 5分钟无活动断连（两个独立项目用同一数值）
const CONNECT_TIMEOUT_MS = 15_000;        // 建连超时
const CALL_TIMEOUT_MS    = 30_000;        // 单次调用超时（建连比调用更短）
const MAX_CONCURRENT     = 20;            // 最多同时维持的连接数
const MAX_RETRIES        = 3;
const RETRY_BASE_MS      = 500;           // 指数退避基数
const RETRY_MAX_MS       = 8_000;         // 退避上限
```

**重试策略（借鉴 mcp-tool-search）：**
- 只重试 transport 层错误：`EPIPE / ECONNRESET / ERR_IPC_CHANNEL_CLOSED / Timeout`
- 不重试应用层错误（tool 返回 error 可能不幂等）
- 指数退避 + 随机抖动（防止多 Agent 并发场景的惊群效应）

**stdio 单信道保护（借鉴 lazy-mcp）：**
- 每个 MCP server 维护独立的 mutex，同一 server 的调用串行化
- 不同 server 之间可以并发
- `timer.unref()` 确保 idle timeout 不阻止进程正常退出

**LRU 驱逐（借鉴 mcp-tool-search）：**
- 连接数超过 `MAX_CONCURRENT` 时，驱逐 `lastUsed` 最早的连接
- 用 `Map` 插入顺序模拟 LRU，零额外依赖

### Layer 4：Search & Index（P1，实验特性）

**开关：** `ACC_SEARCH=1`（默认 off，不影响基础功能）

#### 4.1 搜索索引构建

```typescript
interface IndexEntry {
  group: string;
  command: string;
  publicName: string;
  summary: string;
  tokens: string[];     // 预计算的 token 列表
  embedding?: number[]; // 可选，需要 ACC_EMBED=1
}

// Tokenizer（借鉴 mcp-tool-search）
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")  // 把 _ - . 等替换成空格
    .split(/[\s_\-]+/)
    .filter(t => t.length > 1);    // 过滤单字符
}
// "feishu_doc" → ["feishu", "doc"]
// "kg_query"   → ["kg", "query"]
```

#### 4.2 搜索评分（多级，借鉴 mcp-tool-search）

```typescript
// 有实验基础的四级权重
for (const qt of queryTokens) {
  if (tokens.includes(qt))                               score += 3; // 精确匹配
  else if (tokens.some(t => t.startsWith(qt)))           score += 2; // 前缀匹配
  else if (tokens.some(t => t.includes(qt)))             score += 1; // 子串匹配
  else if (publicName.toLowerCase().includes(qt))        score += 2; // 工具名直接包含
  // Levenshtein 容错：只在 token 长度 ≥ 4 时启用
  // 防止 "get"↔"set"(距离=1) 等短词误匹配
  else if (qt.length >= 4 && minLevenshtein(qt, tokens) <= 2) score += 0.5;
}
```

若 `ACC_EMBED=1`，embedding 相似度作为额外加权项叠加到以上分数。

#### 4.3 两层 LRU Cache（借鉴 mcp-tool-search）

```typescript
// 搜索结果缓存：60s TTL（查询结果会随频率统计变化，不能永久缓存）
const searchCache = new LRUCache<SearchResult[]>({ maxEntries: 128, ttlMs: 60_000 });

// Schema 缓存：不过期（注册完就不变，直到 registry reload）
const schemaCache = new LRUCache<ParamDef[] | null>({ maxEntries: 256, ttlMs: 0 });
// 用 null 作哨兵值缓存"确认不存在"的 key，避免重复查询
```

**LRU 实现：** 用 `Map` 模拟（`delete` + 重新 `set` = 移到末尾），零依赖。

#### 4.4 频率统计

```typescript
interface UsageStat {
  group: string;
  command: string;
  sessionId?: string;
  agentId?: string;
  count: number;
  lastUsed: number;
}
```

频率权重叠加到搜索分数：`finalScore = searchScore + log(count + 1) * FREQ_WEIGHT`

### Layer 5：Dynamic Help（P1，实验特性）

**开关：** `ACC_DYNAMIC_HELP=1`

根据上下文动态调整 `--help` 输出的内容和详细程度。

#### 5.1 弹性展开策略（有设计依据）

```
注册工具总数 ≤ 10  → 完全展开：所有 command + 完整参数说明
注册工具总数 11-30 → 中等展开：group + command 名，折叠参数
注册工具总数 > 30  → 最小展开：只展示 group 层级
```

频率/语义命中的工具，突破折叠阈值，始终展开。

#### 5.2 上下文注入

```
acc --help [--session <id>] [--agent <id>] [--intent "用户说的话"]
```

- `--session`：加载该 session 的历史频率统计
- `--agent`：加载该 agent 的工具使用画像
- `--intent`：语义搜索，将最相关的工具排到前面展开

### Layer 6：Batch Engine（P2，实验特性）

**开关：** `ACC_BATCH=1`

#### 6.1 自动检测与保存

检测条件：同一 session 连续 3+ 个 CLI 调用，且调用间存在数据依赖（前一个的输出被后一个引用）。

```yaml
# 自动保存的批处理格式
batch_id: "feishu-to-kg-sync-abc123"
commands:
  - "acc feishu doc --token {token}"
  - "acc kg import --source {prev_output}"
  - "acc kg query --verify --query {original_intent}"
created_by_agent: "main"
created_in_session: "sess_abc123"
trigger_tokens: ["feishu", "sync", "kg"]  # 触发场景的关键词
usage_count: 0
```

#### 6.2 再现与推荐

当新对话的 `--intent` 或近期命令序列与 `trigger_tokens` 匹配度超过阈值，在 `--help` 末尾追加：

```
💡 Suggested batches:
  acc batch run feishu-to-kg-sync-abc123   # "Sync Feishu doc to knowledge graph"
```

### Layer 7：Auto-Taxonomy（P2，实验特性）

**开关：** `ACC_TAXONOMY=1`

当注册工具数超过阈值（默认 30）时，自动将平铺的工具聚类为树形结构。

两种模式：
- **向量模式（默认）：** 用 tokenize 后的词袋相似度聚类（不依赖 embedding）
- **Agentic 模式（`ACC_TAXONOMY=agentic`）：** Agent 通过 `acc reorganize` 命令交互式重组

---

## 4. 数据流

### 4.1 工具注册流（启动时）

```
配置文件 (acc-registry.yaml)
  │
  ├─ MCP sources → MCP Adapter → listTools() → RawToolDef[]
  ├─ Script sources → Script Adapter → parse --help → RawToolDef[]
  └─ Custom sources → Custom Adapter → read YAML → RawToolDef[]
                              │
                         Registry.register()
                              │
                    ┌─────────┴──────────┐
                    │                    │
               ToolEntry[]          SearchIndex
               (持久化到磁盘)      (内存，可重建)
```

### 4.2 工具调用流（运行时）

```
Agent: exec("acc feishu doc --token xxx --url yyy")
  │
  ▼
CLI Parser → { group: "feishu", command: "doc", args: { token, url } }
  │
  ▼
Registry.resolve("feishu", "doc") → ToolEntry + AdapterRef
  │
  ▼
ConnectionPool.call(adapterRef, args)
  │  ├─ 已有连接？→ 直接用
  │  └─ 没有？→ 建连（15s 超时）→ 加入池
  │
  ▼
实际后端调用（30s 超时，失败最多重试 3 次，指数退避）
  │
  ▼
结果 → stdout（成功）/ stderr（失败 + Usage 提示）
```

### 4.3 Help 查询流（运行时）

```
Agent: exec("acc --help [--intent '同步飞书文档']")
  │
  ▼
HelpGen.build(intent?, sessionId?, agentId?)
  │
  ├─ 无 intent → 按频率 + 弹性展开策略输出
  └─ 有 intent → SearchEngine.query(intent) → top-K 工具排到最前面
  │
  ▼
stdout（格式化的帮助文本）
```

---

## 5. 配置格式

```yaml
# acc-registry.yaml

# 全局设置
settings:
  maxConcurrentConnections: 20
  idleTimeoutMs: 300000
  features:
    dynamicHelp: false     # ACC_DYNAMIC_HELP
    search: false          # ACC_SEARCH
    batch: false           # ACC_BATCH
    taxonomy: false        # ACC_TAXONOMY
    embedding: false       # ACC_EMBED

# 工具来源
sources:
  - type: mcp
    name: feishu
    group: feishu           # acc feishu <command>
    transport: stdio
    command: "npx"
    args: ["-y", "@example/feishu-mcp"]

  - type: mcp
    name: kg
    group: kg
    transport: http
    url: "http://localhost:8080/mcp"

  - type: script
    name: ops-scripts
    group: ops              # acc ops <script-name>
    path: "./scripts/"

  - type: custom
    name: my-tools
    config: "./my-tools.yaml"

# 别名（解决命名冲突 / 简化命令）
aliases:
  "feishu/doc": "doc"       # acc doc → acc feishu doc
```

---

## 6. 开发优先级

### P0 — 核心可用（目标：能替代现有 native 模式跑完测试用例）

- [ ] CLI 壳：`acc <group> <command>` 路由 + `--help` 生成
- [ ] Registry：工具注册、命名去重、元数据管理
- [ ] MCP Adapter：从 MCP server 导入工具
- [ ] Script Adapter：注册 shell 脚本为 CLI 命令
- [ ] Connection Pool：懒连接 + TTL 驱逐 + 重试退避
- [ ] 错误输出附 Usage 提示

### P1 — 智能发现（目标：动态 help 让 Agent 找到工具更准）

- [ ] Search Engine：多级评分（精确→前缀→子串→编辑距离）
- [ ] LRU Cache：搜索结果 + Schema 双层缓存
- [ ] 频率统计：per-session、per-agent 调用记录
- [ ] Dynamic Help：`--intent` 注入 + 弹性展开

### P2 — 高级聚合（目标：工具规模大时仍保持可用）

- [ ] Batch Engine：自动检测复杂操作序列 → 批处理
- [ ] Auto-Taxonomy：词袋聚类 → 树形结构
- [ ] 反向导出：CLI 注册 → MCP Server / OpenAI FnCall Schema

### P3 — 可选增强

- [ ] Embedding：语义向量匹配（需要外部 embedding API 或本地 ONNX 模型）
- [ ] Agentic Taxonomy：Agent 交互式重组命令结构
- [ ] Windows PowerShell / CMD 输出格式

---

## 7. 起源

ACC 的核心思路来自一个内部 Agent 项目的实验分支：
- CLI 模式的工具过滤逻辑
- Registry、RPC daemon、Adapter 的雏形实现
- Token 节省 benchmark（27% 减少的实验数据）

ACC 是这些实验代码的提取和通用化，可独立部署到任何 Agent 环境。

---

## 8. 参考竞品

| 项目 | 相似点 | 差异 |
|------|--------|------|
| [voicetreelab/lazy-mcp](https://github.com/voicetreelab/lazy-mcp) ⭐77 | 树形层级 + 懒加载 | MCP 形态，非 CLI |
| [mquan/nimble](https://github.com/mquan/nimble) ⭐8 | 摘要 + 按需展开 | MCP 形态 |
| [KGT24k/mcp-tool-search](https://github.com/KGT24k/mcp-tool-search) ⭐3 | fuzzy 搜索 + 连接池 | MCP 形态，代码质量最高 |
| [d-kimuson/modular-mcp](https://github.com/d-kimuson/modular-mcp) ⭐47 | group 分组 + 按需加载 | MCP 形态 |

所有竞品都是"MCP → better MCP"，没有做 CLI 范式转换。ACC 在 CLI 入口、Smart Batch、Auto-Taxonomy 三个维度上无竞品。
