/**
 * 本地 JSON 存储：串行化 + 原子写。
 *
 * 抽到 core 是因为两个 provider 都要用它，而它们按 seam 约定不能互相依赖：
 *   - local  用它存卡片和决定记录
 *   - cloud  只用它存决定记录（卡片走网络，决定记录刻意不上传）
 *
 * 复制一份到 cloud 里也能跑，但原子写和串行化这类东西一旦有两份，
 * 迟早只修好其中一份。
 *
 * 这个模块不 import cordis —— 和 guard.ts 一样，能脱离框架单测。
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DecisionRecord } from './types.ts'

export interface StoredCard {
  readonly id: string
  readonly claim: string
  readonly reasoning?: string
  readonly topicVector: readonly number[]
  readonly createdAt: number
}

export interface Store {
  version: 1
  cards: StoredCard[]
  decisions: DecisionRecord[]
}

const EMPTY: Store = { version: 1, cards: [], decisions: [] }

export class JsonStore {
  /** 串行化写入，避免并发 publish 互相覆盖。 */
  private queue: Promise<unknown> = Promise.resolve()

  readonly path: string

  // 不用参数属性（constructor(readonly path: string)）——node 的
  // --experimental-strip-types 是纯剥离，不支持它，测试会直接起不来。
  constructor(path: string) {
    this.path = path
  }

  /** 把一次读—改—写包成原子操作。所有写路径都必须走它。 */
  async mutate<T>(fn: (store: Store) => Promise<T> | T): Promise<T> {
    return this.serialize(async () => {
      const store = await this.read()
      const result = await fn(store)
      await this.write(store)
      return result
    })
  }

  /** 只读，不排队。 */
  async read(): Promise<Store> {
    try {
      const raw = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw) as Partial<Store>
      return {
        version: 1,
        cards: Array.isArray(parsed.cards) ? parsed.cards : [],
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return structuredClone(EMPTY)
      // 文件损坏时不要静默重置——那会悄悄抹掉用户数据
      console.error(`[social/store] 读取失败 ${this.path}:`, err)
      throw err
    }
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    // 吞掉链上的错误，避免一次失败毒化后续所有写入
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async write(store: Store): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    // 原子写：先写临时文件再 rename，避免崩溃时留下半个 JSON
    const tmp = `${this.path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8')
    await rename(tmp, this.path)
  }
}
