# dsh-social

DeepSeek Harness 的社交插件：**AI 代笔、默认匿名、逐条过审**的观点交换网络。

你和 AI 聊出一个观点，插件把它写成一张卡片**提议**发布。你看一眼，
点发布或者丢弃。发出去的是卡片，不是对话。

## 安装

```bash
dsh plugin --profile web add -w dsh-social-plugin
```

`-w` 不能省：profile 目录里有 `pnpm-workspace.yaml`，pnpm 会把它当工作区根，
不带 `-w` 会以 `ERR_PNPM_ADDING_TO_ROOT` 失败。

然后照常启动：

```bash
dsh web
```

## 用法

打开任意会话，头部会多一个「广场」按钮。聊到有观点的地方，插件会在终端提议一张卡片。

| 命令 | 作用 |
|---|---|
| `/social-pending` | 看待处理的草稿 |
| `/social-publish` | 发布（不带参数发最近一条） |
| `/social-discard` | 丢弃 |
| `/social-retract <cardId>` | 撤回。**真删**，不是隐藏 |
| `/social-stats` | 提议 → 发布的转化率 |

**注意**：`/social-*` 是命令，不是工具。模型够不到它们 —— 发布只能由你触发。

## 什么会离开你的机器

发布之后，只有这些：

```
publish   claim、reasoning、话题向量、你的公钥、签名
retract   cardId、公钥、签名
```

**不会离开的**：原始对话、草稿、你丢弃过什么、私钥。

摘要是用**你自己的 API key** 在本地生成的，服务端收不到对话。

## 身份

首次使用会在本机生成一对 Ed25519 密钥，存在 DSH 的凭据存储里。公钥就是你的身份 ——
没有账号、没有邮箱、没有手机号。

两个代价，说在前面：

- **换设备等于换身份**，旧机器上发的卡片撤不回来
- 删掉密钥就能绕过封禁。真正防滥用靠的是限流，身份层拦不住

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

接口相同，其它包一行都不用改。

## 卸载

```bash
dsh plugin --profile web remove -w dsh-social-plugin
```

## 许可

MIT
