# dsh-social

[![npm](https://img.shields.io/npm/v/dsh-social-plugin)](https://www.npmjs.com/package/dsh-social-plugin)
[![源码](https://img.shields.io/badge/GitHub-dsh--social-181717?logo=github)](https://github.com/derek2035/dsh-social)

DeepSeek Harness 的社交插件：**AI 代笔、默认匿名、逐条过审**的观点交换网络。

你和 AI 聊出一个观点，插件把它写成一张卡片**提议**发布。你看一眼，点发布或者丢弃。
发出去的是卡片，不是对话。

## 前置

- Node **22.19+ 或 24+**（`node -v` 看一下，v23 不行）
- 装过 DeepSeek Harness：`npx @deepseek-ai/dsh web` 能起来
- DSH 里配好你自己的模型 API key（插件用**你自己的 key** 在本地生成摘要，
  不会把对话发给任何人）

## 安装

```bash
npx @deepseek-ai/dsh plugin --profile web add -w dsh-social-plugin
```

`-w` 不能省：profile 目录里有 `pnpm-workspace.yaml`，pnpm 会把它当工作区根，
不带 `-w` 会以 `ERR_PNPM_ADDING_TO_ROOT` 失败。

然后照常启动：

```bash
npx @deepseek-ai/dsh web
```

## 怎么用

### 发布观点

跟 AI 聊到有想法的地方，插件会在终端提议一张卡片。过滤器挡掉所有带工具调用的
轮次 —— 你在写代码时它不会打扰你。

| 命令 | 作用 |
|---|---|
| `/social-pending` | 看待处理的草稿 |
| `/social-publish` | 发布（不带参数发最近一条），发完会告诉你有谁在想同一件事 |
| `/social-discard` | 丢弃 |
| `/social-retract <cardId>` | 撤回。**真删**，不是隐藏 |
| `/social-stats` | 提议 → 发布的转化率 |

### 话题广场

打开任意会话，顶部会多一个「广场」tab（和「对话」「轨迹」并列），点进去是整页视图：

- 按话题分组，显示「N 个人在想同一件事」（数**人**不数卡片）
- 搜索过滤
- 点任意一条把它带进输入框，接着跟你的 AI 聊
- 自己发的卡片带「撤回」按钮

### 话题内对话

| 命令 | 作用 |
|---|---|
| `/social-join <cardId前缀>` | 关注一个话题 |
| `/social-say <cardId前缀> <话>` | 在话题里发言 |
| `/social-leave <cardId前缀>` | 取关 |

你在每个话题里有一个**代号**（比如「路人 afnd」）：同一话题内始终不变，
换个话题就是完全不同的代号，没人能把你在不同话题的发言对应起来。

**别人的发言默认不会进入你的会话流。** 想让它进来（这样 AI 也能看见并参与讨论），
把 profile 里 `social-curator` 的 `injectTopics` 改成 `true`：

```yaml
- id: social-curator
  config:
    injectTopics: true
```

打开它意味着接受三件事，请自己权衡：

1. **花 token** —— 别人的话进 prompt，每轮都发
2. **AI 会接话** —— 它看得见，可能主动评论陌生人的观点
3. **别人的话落进你本机的会话日志**，永久保留

**注意**：`/social-*` 是命令，不是工具。模型够不到它们 —— 发布和发言只能由你触发。

## 什么会离开你的机器

发布或发言之后，只有这些：

```
publish   claim、reasoning、话题向量、你的公钥、签名
say       话题 id、发言正文、你的公钥、签名
retract   cardId、公钥、签名
```

**不会离开的**：原始对话、草稿、你丢弃过什么、你关注了哪些话题、私钥。

摘要是用**你自己的 API key** 在本地生成的，服务端收不到对话。

## 身份

首次使用会在本机生成一对 Ed25519 密钥，存在 DSH 的凭据存储里。公钥就是你的身份 ——
没有账号、没有邮箱、没有手机号。

三个代价，说在前面：

- **换设备等于换身份**，旧机器上发的卡片撤不回来
- 删掉密钥就能绕过封禁。真正防滥用靠的是限流，身份层拦不住
- 话题代号对**其他用户**不可关联，但**服务端**持有映射。
  这是「对用户匿名，对服务端实名」，不是端到端匿名

## 换服务端 / 自建

默认 endpoint 是 `https://social.c01.link`。换成自己的不用改配置文件：

```bash
export DSH_SOCIAL_ENDPOINT=https://你的地址
```

服务端是开源的，零第三方依赖，自己起一个：

```bash
node --experimental-strip-types server/bin.ts --db ./social.db --port 4000
```

## 完全不联网

想只在本机存卡片（不发出去），把 profile 的 `cordis.patch.yml` 里
`social-cloud` 那段换成：

```yaml
- id: social-local
  name: 'dsh-social-plugin/local'
  config:
    kAnonymityThreshold: 5
```

接口相同，其它包一行都不用改。本地模式下话题发言会明确报错而不是假装成功 ——
本机没有别人。

## 卸载

```bash
npx @deepseek-ai/dsh plugin --profile web remove -w dsh-social-plugin
```

## 许可

MIT
