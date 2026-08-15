# dsh-social

DeepSeek Harness 社交插件 —— AI 代笔、默认匿名、关系需双向确认的观点交换网络。

当前状态：**阶段 1 骨架**。类型检查通过，28 个单元测试通过，
但**尚未在真实 DSH 上运行过**。

---

## 怎么跑

**日常使用**（插件已装进 `~/.dsh/profiles/web`，照常敲就带着它）：

```bash
npx @deepseek-ai/dsh web
```

改了代码要重新构建再重启：

```bash
pnpm run build:bundle
```

安装 / 卸载（注意 `-w`，不带会被 pnpm 11 拦下）：

```bash
npx @deepseek-ai/dsh plugin --profile web add -w /Users/derek/code/dsh-social/bundle
npx @deepseek-ai/dsh plugin --profile web remove -w dsh-social-plugin
```

---

## 开发时怎么跑

```bash
# 类型检查（在真实 DSH 类型下）
npx tsc -p tsconfig.json --noEmit

# 单元测试（28 个）
node --test --experimental-strip-types test/*.test.ts
```

跑真实的 Web UI：

```bash
cd /Users/derek/code/deepseek-harness
PATH=/usr/local/bin:$PATH pnpm dsh web \
  --patch /Users/derek/code/dsh-social/cordis.yml --port 3081
```

⚠️ **`--patch` 必须写在 `--port` 前面。** `--patch` 是 launcher 的 flag，
`--port` 是 app 的参数；launcher 的解析在第一个它不认识的 token 处停止，
之后原样交给 app。写反了报 `unknown option '--patch'`。

⚠️ 需要**源码检出**的 DSH。`npx @deepseek-ai/dsh` 那份 CLI 不带 TS loader，
加载不了本项目的 `.ts` 插件模块。源码路径走的是 `node --import tsx/esm`。

⚠️ Node 必须是 `^22.19 || >=24`。本机用 `/usr/local/bin/node`（v22.21.1），
PATH 里默认那个 v23 不满足 DSH 的 engines。

没有检出的话：

```bash
git clone https://github.com/deepseek-ai/deepseek-harness
cd deepseek-harness
PATH=/usr/local/bin:$PATH pnpm install   # 网络差会中途 fetch failed，重跑续传
PATH=/usr/local/bin:$PATH pnpm run build # web runner 需要构建产物
```

本项目通过 `package.json` 里四条 `link:../deepseek-harness/...` 依赖那份检出，
换位置要改这四条。

---

## 现状

2026-08-15 在真实 DSH 上端到端跑通过：

真人发言 → `session/event` → 轮次统计 → 启发式 →
`ctx.llm.stream()` 后台摘要 → 草稿卡片 → `/social-publish` →
`assertApproved()` → 落盘 → `/social-retract` 真删。

五个命令在 Web UI 命令面板里可见可执行：
`/social-publish`、`/social-discard`、`/social-pending`、
`/social-retract`、`/social-stats`。

探针模式（`cordis.yml` 里 `probe: true`）会打印每轮的字数、工具调用数、
是否够格提议，卸载时打印事件类型直方图。

**最该盯「值得提议」的通过率。** 过滤器会挡掉所有带工具调用的轮次，
所以正常写代码的会话里这个数应该接近 0 —— 那不是 bug，
是 `docs/01-产品设计.md` 10.1 那个宿主风险的实测证据。

三个不确定项已全部落地，答案和踩过的坑见 `HANDOFF.md`。

---

## 不确定项 —— 已全部落地

| 项 | 结论 |
|---|---|
| `ctx.llm` 真实签名 | `ctx.llm.stream(GenerateOptions)` + `BlockAssembler`；`provider`/`model` 必填，路由从 `request/context` 捡。`llm.ts` 已删成一条路径 |
| `ctx.commands.register` 签名 | `{ name, description, input?, recordInput?, handler }`，`handler` 返回 `CommandResult` |
| 会话事件写入 API | **不能写。** 外部插件的自定义事件类型不在 `KNOWN_SESSION_EVENT_TYPES` 白名单里，读日志时会被拒绝解释，那条会话永久打不开。退回 `ctx.emit` |
| `@deepseek-ai/dsh-session/types` 模块路径 | 路径本身是对的，但因为上一条，declaration merging 用不上，改成在 cordis `Events` 上声明 |
| UI 能否触发 command | 能。五个 `/social-*` 在 Web UI 命令面板里可见可执行 |

`types/cordis-shim.d.ts` 已删除，tsconfig 的 paths 映射也去掉了。
现在用的是真实类型，通过 `package.json` 里的 `link:` 依赖解析。

展开的证据和五个真机 bug 见 `HANDOFF.md`。

---

## 还没做

- **Conversation Node（UI）**：需要独立的 client 包 + React + 构建产物。
  技术架构第 6 节有完整方案，但方案要改：草稿事件**不在会话日志里**，
  UI 不能靠回放日志重建状态，只能读 `social` 服务。
- **cloud provider**：接口已定（技术架构第 8 节），等 local 验证完再写。
- **阶段 2-4**：匿名 thread、双盲匹配、多人房间。

---

## 下一步

1. 日常用几天，看「值得提议」的通过率 —— 这是宿主选得对不对的实测数据
2. 用 `/social-stats` 收集转化率
3. 动手做 Conversation Node（注意上面那条方案变更）

第 3 步不需要服务端、不需要第二个用户，就能拿到那个生死线数字。
