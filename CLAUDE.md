# dsh-social — 给 agent 的项目须知

先读 `HANDOFF.md`。它有完整现状、三个待验证项、和下一步该做什么。

## 硬约束（不要违反）

**① 不要在 `packages/commands/` 里注册任何 tool。**
发布是用户动作，不是模型动作。用 `ctx.commands`（无需模型轮次即可分派）。
做成 tool 就意味着模型能自己决定发布，违反「发出前必须用户过审」。

**② 不要让 `packages/core/src/guard.ts` 依赖 cordis 或任何框架。**
它是唯一的授权闸门，必须能脱离框架单测。
所有 provider 的 `publish()` 第一行必须调 `assertApproved()`。

**③ 不要把 `assessRisk()` 变成拦截逻辑。**
它只提示，不阻断。默认私密 + AI 提议发布——不是默认公开 + AI 拦截。
失败不对称：误报只是多打扰一次，漏报是不可逆泄露。

**④ 不要在 provider 之外的包里发网络请求。**
网络出口收敛在 provider 一个地方，便于审计。

**⑤ 不要把原始对话发到服务端。**
摘要用 `ctx.llm`（用户自己的 key）在本地生成，服务端只收过审后的卡片正文。

改动涉及以上任一条时，先读 `docs/01-产品设计.md` 的「三条不可推翻的决策」，
并在回复里说明为什么这次是例外。

## 命令

```bash
npx tsc -p tsconfig.json --noEmit              # 类型检查
node --test --experimental-strip-types test/*.test.ts   # 28 个测试
```

## 代码约定

- TS strict，含 `noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`
- 可选字段用 `...(x === undefined ? {} : { x })`，不要直接赋 `undefined`
- 注释写「为什么」，不写「是什么」
- 涉及隐私边界的代码，注释里说明违反后果

## 当前状态

阶段 1 后端骨架完成，2026-08-15 已在真实 DSH 上端到端跑通。
`types/cordis-shim.d.ts` 已删除，现在用真实类型（`package.json` 里
四条 `link:../deepseek-harness/...`）。

跑起来（注意 `--patch` 必须在 `--port` 前）：

```bash
cd /Users/derek/code/deepseek-harness
PATH=/usr/local/bin:$PATH pnpm dsh web \
  --patch /Users/derek/code/dsh-social/cordis.yml --port 3081
```

改代码前先读 `HANDOFF.md` 的「踩过的坑」——那五条全是真机才暴露的，
静态检查和单测发现不了。
