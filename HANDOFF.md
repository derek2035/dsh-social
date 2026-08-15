# 交接文档

> 写给下一个接手的人（可能是你自己，也可能是新会话里的 agent）。
> 最后更新：2026-08-15

---

## 一分钟现状

**这是什么**：DeepSeek Harness 的社交插件。让用户与 AI 对话中产生的观点，
以极低成本、逐条授权的方式交换出去。

**做到哪了**：阶段 1 后端骨架，**已经在真实 DSH 上端到端跑通过**（2026-08-15）。
类型检查在真实类型下通过，28 个单元测试通过，
「AI 提议 → /social-publish → 落盘 → /social-retract 真删」整条链路验证过一遍。

**下一步**：Conversation Node（UI）。三个不确定项已经全部落地，见下。

---

## 怎么跑起来

需要一份**源码检出**的 DSH（npm 装的那个 CLI 不带 TS loader，加载不了 .ts 插件）。

本机已经准备好了：

| 东西 | 位置 |
|---|---|
| DSH 源码检出（已 install + build） | `/Users/derek/code/deepseek-harness` |
| Node | 必须用 `/usr/local/bin/node`（v22.21.1）。DSH 的 engines 是 `^22.19 \|\| >=24`，PATH 里默认那个 v23 不满足 |
| 本项目链接到检出的包 | `package.json` 的 `dependencies` 里四条 `link:../deepseek-harness/...` |

```bash
cd /Users/derek/code/deepseek-harness
PATH=/usr/local/bin:$PATH pnpm dsh web \
  --patch /Users/derek/code/dsh-social/cordis.yml --port 3081
```

⚠️ **`--patch` 必须写在 `--port` 前面。** `--patch` 是 launcher 的 flag，
`--port` 是 app 的参数，launcher 的解析在第一个它不认识的 token 处就停了。
写成 `dsh web --port 3081 --patch ...` 会报 `unknown option '--patch'`。

用 3081 是因为 3080 上还跑着一个 `npx @deepseek-ai/dsh web`（你自己那个，没动它）。

从头准备一份新检出：

```bash
git clone https://github.com/deepseek-ai/deepseek-harness
cd deepseek-harness
PATH=/usr/local/bin:$PATH pnpm install   # 网络差会中途 fetch failed，重跑即可续
PATH=/usr/local/bin:$PATH pnpm run build # web runner 需要构建产物
```

---

## 日常使用：已装进你真实的 profile

插件已经打成组合包装进 `~/.dsh/profiles/web`，你照常敲平时那条命令就带着它：

```bash
npx @deepseek-ai/dsh web
```

profile 的 `package.json` 里 `dsh.profile.bundles` 已经多了 `dsh-social-plugin`
（`dsh plugin add` 装完会自动对账，不用手写）。

### 改了代码怎么生效

```bash
cd /Users/derek/code/dsh-social
pnpm run build:bundle     # esbuild 把三个入口各打成一个自包含 JS
# 然后重启 dsh
```

装进 profile 的是**软链**，指向 `/Users/derek/code/dsh-social/bundle`，
所以重新构建后不用重新安装。但反过来说：
**`/Users/derek/code/dsh-social` 和 `/Users/derek/code/deepseek-harness`
两个目录都不能删、不能挪**，挪了插件就加载不了。

### 卸载

```bash
npx @deepseek-ai/dsh plugin --profile web remove -w dsh-social-plugin
```

### ⚠️ `dsh plugin add` 必须带 `-w`

```bash
npx @deepseek-ai/dsh plugin --profile web add -w /Users/derek/code/dsh-social/bundle
```

不带 `-w` 会失败：

```
ERR_PNPM_ADDING_TO_ROOT  Running this command will add the dependency to the workspace root...
dsh: pnpm failed in profile directory /Users/derek/.dsh/profiles/web
```

原因：profile 目录里有 `pnpm-workspace.yaml`，pnpm 11 把它当成工作区根，
`add` 到根需要显式 `-w`。`dsh plugin` 是把参数原样转发给 pnpm 的，所以 `-w` 传得进去。
文档里没写这条（文档假设的 pnpm 版本更老）。

### 开发用的 `--patch` 路子还留着

`cordis.yml`（仓库根那个，绝对路径版）没有删。改 TS 想立刻看效果、
不想每次构建时，仍然可以用源码启动：

```bash
cd /Users/derek/code/deepseek-harness
PATH=/usr/local/bin:$PATH pnpm dsh web \
  --patch /Users/derek/code/dsh-social/cordis.yml --port 3081
```

两条路的分工：`--patch` + 源码 = 改代码时用（TS 直接加载，不用构建）；
bundle = 日常用（不用记参数，不用 cd 到仓库）。

### 版本错位：核过了，安全

| | 版本 |
|---|---|
| npx 装的 CLI（你日常用的） | `dsh` 0.1.0-rc.6 |
| 源码检出 | `dsh` 0.1.0-rc.5 |
| 两边的 cordis | 都是 4.0.1 |
| 会话事件白名单 | 44 条，**逐条一致** |
| `SESSION_FORMAT_VERSION` | 两边都是 0 |

所以 rc.5 源码写的会话，rc.6 打得开；反之亦然。已经实测：
用 rc.6 CLI 打开源码 rc.5 建的会话、执行 `/social-stats`，正常。

注意 `$DSH_HOME/profiles/node_modules` 是个「谁最后启动谁修复」的回退目录，
它现在指向哪份安装取决于你上次用哪个 CLI 启动 —— 拿它比版本会得到假结论。
要比就直接比 `~/.npm/_npx/*/node_modules/@deepseek-ai/`。

---

## 三个不确定项 —— 全部落地

### ① `ctx.llm` 真实签名 ✅

`ctx.llm` 是 `LlmRuntime`，一个**适配器注册表**，
根本没有 `complete` / `chat` / `generate`。唯一的调用面是：

```ts
for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
```

`GenerateOptions` 的 `provider` + `model` **必填**，没有「用当前会话的模型」这种默认。
路由从会话日志的 `request/context`（或 `request/header.config`）里捡，
curator 缓存了每个会话的路由。参照实现：`packages/session/session-title-llm/src/index.ts`。

`packages/curator/src/llm.ts` 已经删成这一条路径。

**关于 token 计量**：`GenerateOptions.purpose` 是封闭联合 `'compaction' | 'session-title'`，
外部插件填不进去，留空即可。这不影响 Web UI 的上下文压力显示——
`dsh-token-meter` 是**回放会话日志**算出来的，我们的后台调用不往日志里写
`assistant/message`，所以用户不会看到 token 莫名上涨。真金白银的 API 花费仍然记在用户自己的 key 上。

### ② `ctx.commands.register` 签名 ✅

```ts
ctx.commands.register({
  name, description,
  input?: { hint },
  recordInput?: boolean,
  handler: (invocation) => CommandResult | Promise<CommandResult>,
})
```

`CommandInvocation` 给 `{ commandId, agent, rawInput, signal }`，
`CommandResult` 是 `{ kind: 'success', text? }` 或 `{ kind: 'error', text }`。
五个 `/social-*` 命令已经在 Web UI 的命令面板里验证可见、可执行。

### ③ 会话事件写入 API ❌ —— 结论是**不要写**

原计划是 `session.append('social/draft', ...)`。**真实代码不允许。**

- `packages/core/session/src/known-event-types.ts` 的 `KNOWN_SESSION_EVENT_TYPES`
  是写死的白名单，只含仓库内声明的事件类型
- `session-persistence/src/coordinator.ts` 的 `assertEventsSupported()` 读日志时
  遇到不在白名单、又没有 `ignorable: true` 标记的类型，直接抛
  `SessionFormatUnsupportedError`，**拒绝解释整条日志**
- `Session.append(type, data)` 的签名里**没有**设置 `ignorable` 的入口，
  全仓库也没有任何一处写入它

**外部插件往会话日志 append 自定义事件 = 那条会话永久打不开。**
白名单文件自己的注释承认了这点：注册面「deferred until such a consumer exists」。

所以退回 cordis 的进程内事件（`ctx.emit`）。代价写在
`packages/core/src/events.ts` 顶部：事件不持久化，
Conversation Node 拿不到回放数据源，阶段 1 的 UI 只能读服务而不是读日志。

---

## 项目结构

```
dsh-social/
├── HANDOFF.md          ← 你在读的这个
├── README.md           使用说明
├── cordis.yml          开发用的 patch overlay（绝对路径，配 --patch 用）
├── bundle/             组合包 —— 装进 ~/.dsh/profiles/web 的就是它
│   ├── package.json        声明 dsh.bundle
│   ├── cordis.patch.yml    配置层（按包名引用，不是绝对路径）
│   └── dist/               esbuild 产物，pnpm run build:bundle 生成
├── scripts/
│   └── build-bundle.mjs
├── tsconfig.json       （已不再映射 cordis —— shim 删了，用真实类型）
├── docs/
│   ├── 01-产品设计.md       为什么这么设计。改设计前必读
│   └── 02-技术架构.md       DSH 扩展点、数据流、服务端接口契约
├── packages/
│   ├── core/       [Definition]  类型、守卫、脱敏、话题向量。零框架依赖
│   ├── local/      [Provider]    本地落盘。★不碰网络
│   ├── curator/    [Consumer]    观察、判断、生成草稿。★唯一花 token 的包
│   └── commands/   [Consumer]    用户动作。★刻意不注册任何 tool
└── test/
    ├── core.test.ts    22 个
    └── guard.test.ts    6 个（守架构红线）
```

依赖方向遵循 DSH 的 seam 约定：provider 和 consumer 都只依赖 core，彼此不依赖。
将来 `local` 换 `cloud`，改 cordis.yml 一行。

---

## ★ 三条架构红线 —— 不要改掉

这三条不是代码风格，是产品能不能活的边界。每一条在代码里都有对应的
可验证性质，改动前请先读 `docs/01-产品设计.md` 的「三条不可推翻的决策」。

### ① 发布不是模型动作

**性质**：`packages/commands/src/index.ts` 全文没有 `ctx.tools.register`。

**为什么**：做成模型可调用的 tool，就意味着模型可以自己决定发布，
直接违反「发出前必须用户过审」。`ctx.commands` 的文档承诺是
「无需模型轮次即可分派」——模型根本够不到这条路径。

**把危险动作放在模型够不到的地方，比在 prompt 里叮嘱它可靠。**

**自查**：`grep -rn "tools" packages/commands/src/` 应该只匹配到注释。

### ② 过审守卫是唯一授权闸门

**性质**：`packages/core/src/guard.ts` 不 import cordis，所以能脱离框架单测。

**为什么**：红线必须有测试守着，不能因为「要起整个框架才能测」就不测。
它检查 `userApproved === true`——这个字段看起来冗余（反正只有用户点了
才会调 publish），但它把「未过审的东西被发出去」变成编译期 + 运行期
都挡得住的错误，而不是靠开发者记性。

**规则**：所有 provider 的 `publish()` 第一行必须调 `assertApproved()`。
不是第一行，就是 bug。

### ③ 风险评估只提示，绝不拦截

**性质**：`packages/core/src/redact.ts` 的 `assessRisk()` 只返回提示，无阻断。

**为什么**：设计文档明确否决了「默认公开 + AI 拦截敏感内容」这个方向——

- 失败是不对称的：误报只是多打扰一次，**漏报是不可逆泄露**
- 组合泄露抓不到：三句各自安全，拼起来能定位到人
- 高频提示会把用户训练成无脑放行

**同一个 AI 能力，装在「提议发布」方向，最坏结果只是少发一条；
装在「放行拦截」方向，最坏结果是公司归零。**

`test/core.test.ts` 有一条测试专门守这个性质。

---

## 已验证 vs 未验证（严格边界）

**已验证**（2026-08-15，真实 DSH 源码检出，真实模型 `ppush/gpt-5.6-sol`）：

- 三个插件都能被 DSH 加载并激活
- `tsc --strict` 在**真实类型**下通过（`types/cordis-shim.d.ts` 已删除，
  tsconfig 的 paths 映射也去掉了）
- 28 个单元测试通过
- 完整链路：真人发言 → `session/event` → 轮次统计 → 启发式通过 →
  `ctx.llm.stream()` 后台摘要 → 草稿卡片 → `/social-publish` →
  `assertApproved()` → 落盘 `~/.dsh-social/local-store.json`
- `/social-pending`、`/social-stats`、`/social-retract` 都在 UI 里执行过
- `retract` 是**真删**：`cards` 归 0，`decisions` 保留（转化率数据源，按设计不该删）
- 五个命令在 Web UI 命令面板里可见
- **组合包路径**：`dsh plugin add` 装进真实 profile，用 npx 的 rc.6 CLI 启动，
  插件正常加载、命令正常执行、能打开源码 rc.5 建的旧会话

**仍未验证**：

- cloud provider（还没写）
- Conversation Node（还没写）
- 多会话并发（curator 用 WeakMap 按 session 隔离了状态，但没实测过两个会话同时跑）
- 插件热卸载后再挂载（`ctx.effect` 的直方图打印路径没走过）

## 还没做

- **Conversation Node（UI）** ← 阶段 1 的主要缺口。
  需要独立 client 包 + React + 构建产物，`package.json` 声明 `dsh.client`。
  完整方案见 `docs/02-技术架构.md` 第 6 节。

  三个不确定项已经落地，可以动手了。注意第③项的结论会影响方案：
  草稿事件**不在会话日志里**，所以 Conversation Node 不能靠回放日志重建状态，
  只能读 `social` 服务。这一点和 `docs/02-技术架构.md` 第 6 节的原方案有出入。

- **cloud provider**：接口已定（技术架构第 8 节），等 local 验证完再写。
- **阶段 2-4**：匿名 thread、双盲匹配、多人房间。

---

## 踩过的坑

以下五条都是**真机跑一次才暴露**的，静态检查和单测全都发现不了。

**① cordis 的 `inject` 没有 `{ required, optional }` 形态。**
`Inject<M> = (keyof M)[] | { [K in keyof M]?: M[K] }`（`vendor/cordis/src/registry.ts`）——
对象形态是「服务名 → 拦截配置」。原来写的
`{ required: [], optional: ['llm','jobs'] }` 被解析成「等两个叫 required 和 optional
的服务」，curator 和 commands 永远 PENDING，启动报 `2 entries did not activate`。
真正的可选依赖用 `ctx.get('服务名')`，不写进 `inject`。

**② `session/event` 的监听器签名是 `(session, event)`，两个参数。**
原来写成 `(event) => ...`，把 `Session` 当成事件读，`event.type` 恒为 `undefined`，
所有分支落进 `default`，插件静默失效——不报错，就是什么都不发生。

**③ Service 实例是通过 Proxy 交给消费方的，`#` 私有字段会炸。**
`ctx.social` 拿到的是代理，不是实例。`#` 字段依赖运行时 brand check，
接收者是代理时抛 `TypeError: Receiver must be an instance of class SocialLocal`。
第一次 `/social-publish` 就是这么死的。**用 TS 的 `private`**（编译期约束，
运行时是普通属性，穿得过代理）——DSH 自己的 service 全都这么写。
单测发现不了：单测直接 `new` 实例，没有代理这一层。

**④ 插件之间不能靠往 `ctx` 上挂属性传数据。**
每个插件拿到的 `ctx` 是各自的代理，属性不串门。
原来 curator 把草稿 Map 挂在 `(ctx as any).__socialPendingDrafts`，
commands 那边读到 `undefined`，`?? new Map()` 永久绑定了一个空 Map——
日志里草稿明明生成了，`/social-publish` 却一直回「没有待处理的草稿」。
改成 commands 监听 `social/draft` 事件，方向没变（两个 consumer 仍只依赖 core）。

**⑤ launcher flag 必须写在 app 参数前面。**
`dsh web --patch X --port 3081` ✅，`dsh web --port 3081 --patch X` ❌
（报 `unknown option '--patch'`）。launcher 的解析在第一个不认识的 token 处停止，
之后的一切原样交给 app。

---

以下两条是原来就记着的，仍然成立：

**测试夹具长度**：`judge()` 的 `minUserChars` 是 80。写测试时如果夹具
不到 80 字，会被长度规则先拦下，测不到后面的规则，报错信息会很误导。
已在 `test/core.test.ts` 里留了注释。

**加载顺序**：`local` 必须在 `commands` 之前。commands 声明了
`inject: ['social', 'commands']`，框架会等 social 服务就绪才加载它。
（实际上 cordis 按依赖而非文件顺序决定启动时机，所以这条现在只是习惯。）

---

## 已知的待改项（跑通后才看见的）

**冷却期会被 NONE 消耗掉。** `handleTurnEnd()` 在调模型**之前**就
`lastDraftTurn.set()`，所以模型判定 NONE（没有可提取观点）也照样占掉 3 轮冷却。
好处是防止连续烧 token，坏处是一次误判要等三轮。这是个取舍，不是明显的 bug，
但值得在有真实使用数据后重新决定。

**`/social-retract` 的前缀只在同一个进程内有效。** 发布时提示的是 8 位前缀，
commands 记了一份进程内的 `publishedIds` 来解析它；进程重启后前缀失效，
要用完整 id（这时会明确告诉你「没找到，什么都没删」，不会假装成功）。
service 没有「列出我发过的卡片」接口，cloud 版按设计也不该有
（那等于让客户端能枚举自己的全部发言）。

**没有集成测试。** 28 个单测全在测纯函数，今天那五个 bug 一个都没抓到——
它们全发生在「代码 × cordis」的边界上。补一个跑真实 cordis 的测试
（`new Context()` → `ctx.plugin(SocialLocal)` → 从 `ctx.social` 代理调 `publish`）
就能覆盖 `#` 私有字段和 `inject` 写法这两类。

## 产品上最该记住的一件事

这个项目最大的风险不是技术，是 `docs/01-产品设计.md` 第 10.1 节：

> DSH 是开发者工具，用户在跑代码仓库。话题重合度最高的会是
> 「这个 TypeScript 报错怎么修」——这个场景里人们要的是
> Stack Overflow，不是朋友。

所以第一次跑起来时，**「值得提议」的通过率本身就是最重要的数据**。
它接近 0 的话，说明宿主选错了——这是个应该正视的产品结论，
不是应该调参绕过的技术障碍。

另外，阶段 0 那个转化率测试（`/social-stats`）如果样本是尝鲜极客，
数字不可信：**他们手上没有真实内容**，会虚高或虚低。
真实验证要找有真实使用场景的人，而且这个测试根本不需要产品——
找 20 个人，翻出他们最近一次真实对话，现场生成摘要，问一句
「愿意匿名发出去吗」，今天就能做。
