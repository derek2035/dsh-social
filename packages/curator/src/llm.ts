/**
 * ctx.llm 调用层。
 *
 * ✅ 2026-08-15 在真实检出上核实完毕，六路兜底探测已删除。
 *
 * 真实签名（packages/llm/llm/src/index.ts，参照 dsh-session-title-llm 的用法）：
 *
 *   for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
 *
 * ctx.llm 是 LlmRuntime —— 一个**适配器注册表**，没有 complete/chat/generate
 * 这类方法。唯一的调用面是 stream()，且 provider + model 是必填的：
 * 没有「用当前会话的模型」这种隐式默认，路由必须自己带上。
 *
 * 路由来源：会话日志里的 request/context（或 request/header.config），
 * 由 index.ts 监听并缓存，这样后台调用跟着用户当前选的模型走。
 *
 * 计量：GenerateOptions.purpose 是封闭联合 'compaction' | 'session-title'，
 * 外部插件填不进去，所以留空。这不影响 Web UI 的 token 计量——
 * dsh-token-meter 是**回放会话日志**算出来的（token-meter/src/index.ts），
 * 而我们的后台调用不往会话日志里写 assistant/message，
 * 因此不会让用户看到上下文压力莫名上涨。真金白银的 API 花费仍然记在用户自己的 key 上。
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** 一次后台调用的模型路由。 */
export interface Route {
  readonly provider: string
  readonly model: string
}

/** 后台摘要的输出上限。够写一条卡片，超了说明模型跑偏了。 */
const MAX_OUTPUT_TOKENS = 512

/**
 * 调用模型，返回纯文本；失败返回 null。
 *
 * 注意：这里**故意不抛错**。摘要生成失败绝不能影响用户当前的对话——
 * 一个社交插件把主流程搞崩，用户会立刻卸载。
 */
export async function callModel(
  ctx: Context,
  route: Route,
  prompt: string,
  probe: boolean,
): Promise<string | null> {
  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages: [createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'dsh-social-curator' },
    })],
    maxTokens: MAX_OUTPUT_TOKENS,
  }

  const assembler = new BlockAssembler()
  try {
    for await (const chunk of ctx.llm.stream(options)) {
      assembler.push(chunk)
    }
  } catch (err) {
    console.log(`[social/llm] 调用失败（${route.provider}/${route.model}）：${(err as Error).message}`)
    return null
  }

  const finish = assembler.finish
  if (finish.kind !== 'stop') {
    if (probe) console.log(`[social/llm] 未正常结束：${finish.kind}`)
    if (finish.kind !== 'max-tokens') return null
  }

  const text = assembler.blocks()
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('')

  if (probe) console.log(`[social/llm] ✔ ${route.provider}/${route.model} 返回 ${text.length} 字`)
  return text.length > 0 ? text : null
}
