# ACC 路线图 (Roadmap)

> 原则：**不可冒进**。每个阶段有明确的验收标准，通过验收后才进入下一阶段。未验收的阶段不启动编码。

---

## 阶段总览

```mermaid
graph LR
    P0["Phase 0<br/>脚手架"] --> P1["Phase 1<br/>最小可调用"]
    P1 --> P2["Phase 2<br/>生产可用"]
    P2 -->|"日常使用稳定"| P3["Phase 3<br/>智能发现"]
    P3 --> P4["Phase 4<br/>高级特性"]

    style P0 fill:#4a9eff,color:#fff
    style P1 fill:#4a9eff,color:#fff
    style P2 fill:#f5a623,color:#fff
    style P3 fill:#7b61ff,color:#fff
    style P4 fill:#9e9e9e,color:#fff
```

| 阶段 | 定位 | 前置条件 | 对应架构优先级 |
|------|------|---------|--------------|
| **Phase 0** | 脚手架与技术选型 | 无 | — |
| **Phase 1** | 最小可调用：一个 MCP server 能跑通 | Phase 0 完成 | P0 前半 |
| **Phase 2** | 生产可用：能替代现有 native 模式 | Phase 1 验收通过 | P0 后半 |
| **Phase 3** | 智能发现：搜索 + 频率 + 动态 Help | Phase 2 验收通过，日常使用稳定 | P1 |
| **Phase 4** | 高级聚合：Batch + Taxonomy + 导出 | Phase 3 验收通过 | P2 |

---

## Phase 0 — 脚手架与技术选型

**目标：** 确定技术栈，搭建项目骨架，所有后续开发在此基础上进行。

### 待决策项

| 决策点 | 候选方案 | 考量 |
|--------|---------|------|
| 语言 | TypeScript (Node.js) / Go / Rust | 架构文档的接口定义用 TS 写，MCP 生态以 TS 为主 |
| CLI 框架 | yargs / commander / 手写 parser | 需要支持两级子命令 + `--help` 自定义格式 |
| 包管理 | npm / pnpm | monorepo 需求？ |
| 构建 | tsc / esbuild / tsup | 需要单文件输出以便分发 |
| 测试框架 | vitest / jest | — |
| 配置格式 | YAML（架构文档已定义） | 解析库选择：js-yaml / yaml |

### 交付物

- [ ] `package.json` + 构建配置
- [ ] 项目目录结构（`src/`、`test/`、`config/`）
- [ ] `.gitignore`、`tsconfig.json`
- [ ] `acc` 入口脚本可以被 `node ./dist/cli.js --help` 调用（即使只输出占位文字）
- [ ] 本文档中的决策项全部敲定

### 验收标准

```bash
# 能跑起来，能输出 help
node ./dist/cli.js --help
# 输出类似: "acc - Agentic CLI Center\n\nUsage: acc <group> <command> [options]"
echo $?  # 应为 0
```

---

## Phase 1 — 最小可调用（P0 核心前半）

**目标：** 能注册一个 MCP server 的工具，通过 `acc <group> <command>` 成功调用。这是验证架构可行性的最短路径。

### 1.1 CLI 壳 (Layer 0)

对应架构文档 Layer 0。

- [ ] 解析 `acc <group> <command> [--key value ...]` 格式
- [ ] 三级 `--help` 输出：
  - `acc --help` → 列出所有 group
  - `acc <group> --help` → 列出 group 下所有 command
  - `acc <group> <command> --help` → 完整参数说明
- [ ] stdout / stderr 分离
- [ ] 未知 group/command 时输出错误 + 建议

### 1.2 Registry (Layer 1)

对应架构文档 Layer 1。

- [ ] `ToolEntry` 数据结构定义
- [ ] `Registry.register()` / `Registry.resolve()` / `Registry.list()` 方法
- [ ] `publicName` = `group/command` 命名规范
- [ ] 命名冲突检测：冲突时 warn + skip

### 1.3 MCP Adapter (Layer 2 — 仅 MCP 部分)

对应架构文档 Layer 2，**只做 MCP stdio 类型**。

- [ ] 读取 `acc-registry.yaml` 中 `type: mcp` 的配置
- [ ] 启动 MCP server 子进程（stdio transport）
- [ ] `listTools()` → 解析 `inputSchema` → 转为 `ParamDef[]`
- [ ] `call()` → JSON-RPC `tools/call`
- [ ] `close()` → 优雅关闭子进程

### 里程碑验收

```bash
# 前置：准备一个简单的 MCP server（可从 @modelcontextprotocol/server-filesystem 等现成包中选）
# 配置到 acc-registry.yaml

# 1. 能列出工具
acc --help
# 应输出包含该 MCP server 工具的 group 列表

# 2. 能看到具体命令
acc <group> --help

# 3. 能调用
acc <group> <command> --param value
# 返回结果到 stdout
```

> **不做的事：** Connection Pool、重试机制、多 server 并发、Script Adapter — 这些全部推到 Phase 2。
> 每个 MCP 调用直接"建连→调用→断连"，是最简单但能验证链路的方式。

---

## Phase 2 — 生产可用（P0 核心后半）

**目标：** 可以替代现有 native 模式跑完测试用例。多 server、连接池、重试、脚本适配全部就位。

### 2.1 Connection Pool (Layer 3)

对应架构文档 Layer 3。

- [ ] 懒连接：首次调用时才建连
- [ ] LRU 驱逐：`MAX_CONCURRENT = 20`
- [ ] Idle TTL：5 分钟无活动断连
- [ ] 超时控制：建连 15s，调用 30s
- [ ] 重试策略：只重试 transport 层错误，指数退避 + 抖动
- [ ] stdio 单信道 mutex：同一 server 串行化
- [ ] `timer.unref()` 确保不阻止进程退出

### 2.2 Script Adapter (Layer 2 — Script 部分)

- [ ] 扫描指定目录下的脚本文件
- [ ] 解析 `--help` 输出 / 文件头注释 → 生成 `ParamDef[]`
- [ ] `call()` → `child_process.spawn`，捕获 stdout/stderr
- [ ] 权限检查（脚本需要可执行权限）

### 2.3 错误处理强化

对应架构文档 Layer 0 的"错误响应附 schema"设计。

- [ ] 所有错误输出到 stderr
- [ ] 错误消息格式：`ERROR: <msg>\nUsage: acc <group> <command> --param <type>`
- [ ] 参数缺失 / 类型错误 / 后端超时等场景全覆盖
- [ ] 非零退出码（区分用户参数错误 vs 后端错误）

### 2.4 配置文件完善

- [ ] `acc-registry.yaml` 完整解析（`settings` + `sources` + `aliases`）
- [ ] `aliases` 功能实现
- [ ] 配置校验 + 每个字段的默认值

### 里程碑验收

```bash
# 1. 多 server 并发调用不出错
acc feishu doc --token xxx &
acc kg query --q "test" &
wait

# 2. 连接池行为（可通过日志观察）
ACC_LOG=debug acc feishu doc --token xxx
# 日志应显示"reusing connection"而非每次新建

# 3. 重试（模拟后端挂掉后恢复）
# 应在日志中看到退避重试

# 4. 脚本工具
acc ops <script-command> --param value

# 5. 与内部 PoC 对比
# 在同等 8 轮对话 benchmark 中，token 节省 ≥ 25%
```

> **关键门槛：** Phase 2 完成后，ACC 必须能替代现有 native 模式在实际场景中使用。达不到则不进入 Phase 3。

---

## Phase 3 — 智能发现（P1）

**前置条件：** Phase 2 验收通过，日常使用稳定至少 1 周。

**目标：** Agent 能通过语义 / 频率信息更精准地找到工具，减少无效探索。

### 3.1 Search Engine (Layer 4)

- [ ] `tokenize()` 实现
- [ ] 多级评分：精确匹配(3) → 前缀(2) → 子串(1) → 编辑距离(0.5)
- [ ] `publicName` 包含查询词的额外加分(2)
- [ ] Levenshtein 距离：仅 token ≥ 4 字符时启用，阈值 ≤ 2
- [ ] `acc search <query>` 子命令

### 3.2 LRU Cache

- [ ] 搜索结果缓存：60s TTL，128 entries
- [ ] Schema 缓存：不过期，256 entries
- [ ] `null` 哨兵值缓存"确认不存在"
- [ ] 用 `Map` 的 delete + re-set 模拟 LRU

### 3.3 频率统计

- [ ] `UsageStat` 记录：per-session、per-agent
- [ ] 持久化到磁盘（JSON 文件或 SQLite）
- [ ] 频率权重叠加：`finalScore = searchScore + log(count + 1) * FREQ_WEIGHT`

### 3.4 Dynamic Help (Layer 5)

- [ ] 弹性展开：≤10 完全展开，11-30 中等展开，>30 只展示 group
- [ ] `--intent` 参数：语义搜索 → 相关工具排前面展开
- [ ] `--session` / `--agent` 参数：加载历史频率

### 里程碑验收

```bash
# 1. 搜索能用
ACC_SEARCH=1 acc search "飞书文档"
# 应返回 feishu/doc 排在第一

# 2. Dynamic Help
ACC_DYNAMIC_HELP=1 acc --help --intent "同步知识图谱"
# kg 相关工具应排在前面

# 3. 频率生效
# 连续调用某工具多次后，无 intent 的 --help 中该工具应更靠前
```

> **Feature flag 必须全部生效：** 关闭 `ACC_SEARCH` / `ACC_DYNAMIC_HELP` 后，行为必须与 Phase 2 完全一致。

---

## Phase 4 — 高级特性（P2）

**前置条件：** Phase 3 验收通过。

**目标：** 应对大规模工具集和复杂操作序列的场景。

### 4.1 Batch Engine (Layer 6)

- [ ] 调用序列检测：连续 3+ 调用且有数据依赖
- [ ] 批处理定义文件格式（YAML）
- [ ] `acc batch run <batch-id>` 执行
- [ ] `--help` 末尾的 batch 推荐
- [ ] `trigger_tokens` 匹配逻辑

### 4.2 Auto-Taxonomy (Layer 7)

- [ ] 词袋相似度聚类（向量模式）
- [ ] 工具数 > 30 时自动触发
- [ ] 聚类结果持久化
- [ ] `acc reorganize` 命令（agentic 模式，可选）

### 4.3 反向导出

- [ ] CLI 注册 → MCP Server schema 导出
- [ ] CLI 注册 → OpenAI FnCall schema 导出

### 里程碑验收

```bash
# Batch
ACC_BATCH=1 acc batch list
ACC_BATCH=1 acc batch run <batch-id>

# Taxonomy（注册 30+ 工具后）
ACC_TAXONOMY=1 acc --help
# 应展示聚类后的树形结构

# 导出
acc export --format mcp > tools.json
acc export --format openai > functions.json
```

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| MCP SDK 版本碎片化 | Adapter 兼容性问题 | 先锁定一个 SDK 版本，Phase 1 只支持 stdio transport |
| `--help` 格式设计不好 | Agent 解析困难，达不到 token 节省目标 | Phase 1 就做 A/B 测试：不同 help 格式 vs native schema |
| 连接池复杂度 | 死锁、泄漏 | Phase 1 先不做连接池，Phase 2 有独立的专项测试 |
| 脚本 `--help` 解析不可靠 | Script Adapter 实际不可用 | 支持手动 YAML 声明作为回退，不强依赖自动解析 |
| 频率统计膨胀 | 磁盘/内存压力 | 定时 compact（保留 top-N），或用 SQLite 替代 JSON |

---

## 原则

1. **一个阶段一个 PR**：每个 Phase 合并前必须通过验收标准
2. **Feature flag 守护实验特性**：P1/P2 的所有特性默认 off，不影响 P0 功能
3. **先跑通再优化**：Phase 1 的 MCP adapter 可以每次建连断连，Phase 2 再加连接池
4. **文档先行**：每个 Phase 开始前更新架构文档中对应章节的实现细节
5. **可回退**：任何阶段发现方向有误，可以回退到上一个稳定 Phase
