#!/usr/bin/env node
/**
 * 起服务端。
 *
 *   node --experimental-strip-types server/bin.ts --port 4000 -k 1
 *
 * 单机自测把 -k 设成 1，否则 k-匿名门槛（默认 5）会让 relevant() 永远返回空 ——
 * 那是**正确**行为，不是 bug。调它就是在关掉一条隐私红线，别忘了调回去。
 */
import { createSocialServer } from './src/index.ts'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const port = Number(flag('--port') ?? 4000)
const k = Number(flag('-k') ?? flag('--k-anonymity') ?? 5)

const app = createSocialServer({ kAnonymityThreshold: k })
await app.listen(port)
