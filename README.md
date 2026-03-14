# ACC — Agentic CLI Center

> 把任何来源的 Agent 工具统一转换为 bash CLI 入口，让模型用 `--help` 自然发现工具，而不是在每轮对话里携带几万字符的 JSON schema。

## Why

| 问题 | ACC 的解法 |
|------|-----------|
| 21 个工具 ≈ 15,000 字符 schema，每轮都带 | 统一 CLI 入口，schema → `--help`，O(n) → O(1) |
| 工具越多，模型选择精度越低 | 分层发现：`acc --help` → `acc <group> --help` → `acc <group> <cmd> --help` |
| MCP、Function Calling、脚本各自一套 | 统一适配层：MCP / Script / Custom 都变成 `acc <group> <cmd>` |

**PoC 实验数据（8 轮对话 benchmark）：** schema 字符数 -75%，每轮 prompt tokens -27%。

## Quick Start

```bash
# 安装
pnpm install
pnpm build

# 使用
acc --help                           # 展示所有 group
acc <group> --help                   # 展示 group 下的 command
acc <group> <command> --help         # 展示完整参数说明
acc <group> <command> [--k v ...]    # 执行工具
```

## Configuration

工具通过 `acc-registry.yaml` 注册：

```yaml
sources:
  # MCP server（需要 server 已在运行）
  - type: mcp
    name: my-server
    group: tools
    transport: http
    url: "http://localhost:8080/mcp"

  # Shell 脚本目录
  - type: script
    name: devtools
    group: dev
    path: "./scripts"

aliases:
  "tools/search": "s"     # acc s → acc tools search
```

### Script Tools

脚本用 `#ACC:` 注释声明元数据，ACC 自动扫描和注册：

```bash
#!/bin/bash
#ACC: summary: "同步数据库备份"
#ACC: param: name=target type=string required=true desc="目标路径"
#ACC: param: name=verbose type=boolean desc="详细输出"

echo "Syncing to $target..."
```

## Architecture

```
Agent (LLM)
  │  exec("acc tools search --query xxx")
  ▼
ACC 进程
  ├─ CLI Router → Registry → ConnectionPool → 后端
  ├─ MCP Adapter (HTTP/stdio)
  ├─ Script Adapter (child_process)
  └─ Connection Pool (lazy connect, LRU, retry, mutex)
```

- **Registry (L1):** 工具元数据管理，alias 支持
- **Adapter (L2):** MCP / Script / Custom 统一接口
- **Connection Pool (L3):** 懒连接 + LRU 驱逐 + idle TTL + 指数退避重试

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 和 [docs/ROADMAP.md](docs/ROADMAP.md)。

## Development

```bash
pnpm install
pnpm build          # tsup → dist/cli.js
pnpm test           # vitest

# Debug 模式
ACC_LOG=debug node ./dist/cli.js dev loc --path .
```

## Status

- ✅ **Phase 0** — 脚手架 (TypeScript + commander + tsup + vitest)
- ✅ **Phase 1** — 最小可调用 (MCP stdio adapter, dynamic CLI routing)
- ✅ **Phase 2** — 生产可用 (Connection Pool, Script Adapter, aliases, structured errors)
- 🔲 **Phase 3** — 智能发现 (Search Engine, Dynamic Help)
- 🔲 **Phase 4** — 高级聚合 (Batch Engine, Auto-Taxonomy)

## License

MIT
