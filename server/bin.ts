#!/usr/bin/env node
/**
 * 起服务端。
 *
 *   node --experimental-strip-types server/bin.ts --db ~/.dsh-social/server.db --port 4000 -k 1
 *
 * --db 省略的话用内存库，重启即失。
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

const dbPath = flag('--db')
// 话题广场：还没有用户时用它测通流程。对外开放前必须去掉这个参数。
const square = args.includes('--dev-square')

const app = createSocialServer({
  kAnonymityThreshold: k,
  devPublicSquare: square,
  ...(dbPath === undefined ? {} : { dbPath }),
})
await app.listen(port)
if (dbPath === undefined) {
  console.log('[social/server] 内存库，重启即失。要留数据加 --db <路径>')
}

// Ctrl-C 时把 SQLite 正常关掉，避免留下 WAL 残留
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void app.close().then(() => { process.exit(0) })
  })
}
