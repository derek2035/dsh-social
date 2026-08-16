/**
 * 话题广场 —— 整页视图。
 *
 * 注册在 `conversation.view` 上，和「对话」「轨迹」并列成一个 tab，
 * 点进去占据整个主区域。这是这个宿主里能拿到的最大画布：
 * 全部 root 级槽只有 sidebar.* 和 settings.*，没有独立页面这回事，
 * 而 sidebar.workspaces 是 single 且已被 ui-workspace 占死，加不了分组。
 *
 * 之前那版是头部按钮弹小面板，只能看不能参与 —— 跟「广场」这个词的承诺不符。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

interface SquareCard {
  /** 注意是 id 不是 cardId —— 宿主返回的是 core 的 RemoteCard 形状。 */
  readonly id: string
  readonly claim: string
  readonly reasoning?: string
}

interface SquareGroup {
  readonly title: string
  /** 有多少个**不同的人**在这个话题下发过。一个人发五张不算五个人。 */
  readonly voices: number
  readonly cards: readonly SquareCard[]
}

interface SquareResponse {
  readonly groups?: readonly SquareGroup[]
  /** 我发过的 cardId。由本地决定记录推导，服务端没有「列出我的卡片」接口。 */
  readonly mine?: readonly string[]
  readonly error?: string
}

type Status =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready', readonly groups: readonly SquareGroup[], readonly mine: ReadonlySet<string> }
  | { readonly kind: 'error', readonly message: string }

export interface SquareViewProps {
  /** 把观点带进输入框用。由框架的 session kit 提供。 */
  readonly inputActions: { setDraft(text: string): void }
}

export function SquareView({ inputActions }: SquareViewProps): React.ReactElement {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    setStatus({ kind: 'loading' })
    try {
      const res = await fetch('/social-api/square')
      const json = await res.json() as SquareResponse
      if (json.error !== undefined) {
        setStatus({ kind: 'error', message: json.error })
        return
      }
      setStatus({
        kind: 'ready',
        groups: json.groups ?? [],
        mine: new Set(json.mine ?? []),
      })
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const visible = useMemo(() => {
    if (status.kind !== 'ready') return []
    const q = query.trim().toLowerCase()
    if (q === '') return status.groups
    // 过滤保留分组结构：整组滤空就不显示，而不是把命中的卡片摊平成一列
    return status.groups
      .map(g => ({
        ...g,
        cards: g.cards.filter(c =>
          c.claim.toLowerCase().includes(q) || (c.reasoning ?? '').toLowerCase().includes(q)),
      }))
      .filter(g => g.cards.length > 0)
  }, [status, query])

  const totalCards = status.kind === 'ready'
    ? status.groups.reduce((n, g) => n + g.cards.length, 0)
    : 0

  /**
   * 把卡片写进输入框。
   *
   * 阶段 1 没有 thread，服务端也没有回复接口（那是设计文档的阶段 2）。
   * 与其做一个假的回复按钮，不如接上宿主本来就擅长的动作 ——
   * 你看到一个观点，想跟自己的 AI 聊它。
   */
  /** 撤回自己发的卡片。三态要分开显示，不能都说成「已撤回」。 */
  const retract = useCallback(async (card: SquareCard) => {
    try {
      const res = await fetch('/social-api/retract', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cardId: card.id }),
      })
      const json = await res.json() as { removed?: boolean, error?: string }
      if (json.error !== undefined) {
        setNotice(`撤回失败：${json.error}`)
        return
      }
      setNotice(json.removed === true ? '已撤回' : '服务端上没有这张卡片，什么都没删')
      await load()
    } catch (err) {
      setNotice(`撤回失败：${(err as Error).message}`)
    }
  }, [load])

  const bring = useCallback((card: SquareCard) => {
    const quoted = card.reasoning === undefined
      ? `「${card.claim}」`
      : `「${card.claim}」\n（${card.reasoning}）`
    inputActions.setDraft(`我在话题广场看到这个观点：\n\n${quoted}\n\n`)
  }, [inputActions])

  return (
    <div style={pageStyle}>
      <style>{CSS}</style>

      <div style={headerStyle}>
        <div>
          <div style={titleStyle}>话题广场</div>
          <div style={subtitleStyle}>
            {status.kind === 'ready'
              ? `${status.groups.length} 个话题 · ${totalCards} 条观点 · 点任意一条把它带进对话`
              : ' '}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value) }}
            placeholder="搜索观点"
            style={searchStyle}
          />
          <button type="button" onClick={() => { void load() }} style={refreshStyle}>刷新</button>
        </div>
      </div>

      <div style={listStyle}>
        {status.kind === 'loading' && <div style={hintStyle}>加载中…</div>}

        {status.kind === 'error' && (
          <div style={hintStyle}>
            <div style={hintTitleStyle}>连不上广场</div>
            <div>{status.message}</div>
            <div style={subHintStyle}>服务端没起来，或者没开 --dev-square</div>
          </div>
        )}

        {notice !== '' && <div style={noticeStyle}>{notice}</div>}

        {status.kind === 'ready' && status.groups.length === 0 && (
          <div style={hintStyle}>
            <div style={hintTitleStyle}>还没有人发过观点</div>
            <div style={subHintStyle}>
              跟 AI 聊到有想法的地方，它会提议一张卡片，你过审后就会出现在这里
            </div>
          </div>
        )}

        {status.kind === 'ready' && status.groups.length > 0 && visible.length === 0 && (
          <div style={hintStyle}>没有匹配「{query}」的观点</div>
        )}

        {status.kind === 'ready' && visible.map((group, gi) => (
          <div key={`${group.title}-${gi}`} style={groupStyle}>
            <div style={groupHeadStyle}>
              <span style={groupTitleStyle}>{group.title}</span>
              {group.voices > 1 && (
                <span style={voicesStyle}>{group.voices} 个人在想同一件事</span>
              )}
            </div>
            {group.cards.map(card => {
              const isMine = status.mine.has(card.id)
              return (
                <div key={card.id} className="dsh-social-card" style={cardStyle}>
                  <button type="button" onClick={() => { bring(card) }} style={cardBodyStyle}>
                    <div style={claimStyle}>{card.claim}</div>
                    {card.reasoning !== undefined && (
                      <div style={reasoningStyle}>{card.reasoning}</div>
                    )}
                  </button>
                  <div style={cardFootStyle}>
                    <span className="dsh-social-cta" style={ctaStyle}>点正文带进对话 →</span>
                    {isMine && (
                      <button
                        type="button"
                        onClick={() => { void retract(card) }}
                        style={retractStyle}
                        title="真删，不是隐藏。删除后所有展示过它的地方同时失效"
                      >
                        我发的 · 撤回
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

// 颜色一律用宿主的 --dsw-* 令牌。自己写死会在另一个主题下整块看不见。
const CSS = `
.dsh-social-card { transition: background 120ms ease, border-color 120ms ease; }
.dsh-social-card:hover { background: var(--dsw-alias-fill-l2); border-color: var(--dsw-alias-border-l1); }
/* CTA 常驻但淡，hover 提亮。做成 opacity:0 的话每张卡都会空出一行高度，
   看起来像排版坏了 —— 占位和可见性是两件事。 */
.dsh-social-card .dsh-social-cta { opacity: .45; transition: opacity 120ms ease; }
.dsh-social-card:hover .dsh-social-cta { opacity: 1; }
`

const pageStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  overflow: 'hidden',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-end',
  gap: 16,
  padding: '20px 24px 16px',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
  maxWidth: 820,
  width: '100%',
  margin: '0 auto',
  boxSizing: 'border-box',
}

const titleStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}

const subtitleStyle: React.CSSProperties = {
  fontSize: 12,
  marginTop: 4,
  color: 'var(--dsw-alias-label-tertiary)',
}

const searchStyle: React.CSSProperties = {
  width: 200,
  padding: '6px 10px',
  fontSize: 13,
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-fill-l2)',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  outline: 'none',
}

const refreshStyle: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 13,
  color: 'var(--dsw-alias-label-secondary)',
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  cursor: 'pointer',
}

const listStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '16px 24px 32px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  // 限宽 + 居中。之前只限宽不居中，右边空一大块，看着像没写完。
  maxWidth: 820,
  width: '100%',
  margin: '0 auto',
  boxSizing: 'border-box',
}

const groupStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  marginBottom: 20,
}

const groupHeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
  padding: '0 2px 2px',
}

const groupTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-secondary)',
}

const voicesStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--dsw-alias-label-tertiary)',
}

const cardStyle: React.CSSProperties = {
  padding: '14px 16px',
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 12,
}

const cardBodyStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: 0,
  border: 0,
  background: 'transparent',
  cursor: 'pointer',
  font: 'inherit',
}

const cardFootStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
  marginTop: 10,
}

const retractStyle: React.CSSProperties = {
  fontSize: 11,
  padding: '3px 8px',
  color: 'var(--dsw-alias-label-tertiary)',
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 6,
  cursor: 'pointer',
}

const noticeStyle: React.CSSProperties = {
  fontSize: 12,
  padding: '8px 12px',
  marginBottom: 8,
  color: 'var(--dsw-alias-label-secondary)',
  background: 'var(--dsw-alias-fill-l2)',
  borderRadius: 8,
}

const claimStyle: React.CSSProperties = {
  fontSize: 15,
  lineHeight: 1.6,
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary)',
}

const reasoningStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.6,
  marginTop: 6,
  color: 'var(--dsw-alias-label-secondary)',
}

const ctaStyle: React.CSSProperties = {
  fontSize: 12,
  marginTop: 10,
  color: 'var(--dsw-alias-label-tertiary)',
}

const hintStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--dsw-alias-label-tertiary)',
  padding: '48px 4px',
  textAlign: 'center',
  lineHeight: 1.8,
}

const hintTitleStyle: React.CSSProperties = {
  fontSize: 15,
  color: 'var(--dsw-alias-label-secondary)',
  marginBottom: 6,
}

const subHintStyle: React.CSSProperties = {
  fontSize: 12,
  marginTop: 6,
  color: 'var(--dsw-alias-label-tertiary)',
}
