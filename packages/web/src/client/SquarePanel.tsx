/**
 * 话题广场面板。
 *
 * 数据来自宿主自己的 /social-api/square —— 浏览器不直连社交服务端，
 * 理由见 ../index.ts 的文件头。
 *
 * 刻意做得很朴素：这个面板现在的用途是**验证链路通没通**，
 * 不是最终形态。等有真实用户、k-匿名真的能满足了，
 * 它应该变成按话题推荐，而不是「所有人的所有卡片」。
 */
import { useCallback, useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

interface SquareCard {
  /** 注意是 id 不是 cardId —— 宿主返回的是 core 的 RemoteCard 形状。 */
  readonly id: string
  readonly claim: string
  readonly reasoning?: string
}

interface SquareResponse {
  readonly cards?: readonly SquareCard[]
  readonly error?: string
}

type Status =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready', readonly cards: readonly SquareCard[] }
  | { readonly kind: 'error', readonly message: string }

/**
 * 槽的标准 props。`inputActions` 由框架的 session kit 提供
 * （见 ui-conversation 的 SessionStandardProps），会话作用域的槽都拿得到。
 */
export type SquarePanelProps = PropsRuntime<'conversation.session.header.actions'>

export function SquarePanel({ inputActions }: SquarePanelProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'loading' })

  const load = useCallback(async () => {
    setStatus({ kind: 'loading' })
    try {
      const res = await fetch('/social-api/square')
      const json = await res.json() as SquareResponse
      if (json.error !== undefined) {
        setStatus({ kind: 'error', message: json.error })
        return
      }
      setStatus({ kind: 'ready', cards: json.cards ?? [] })
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message })
    }
  }, [])

  useEffect(() => { if (open) void load() }, [open, load])

  /**
   * 点卡片 → 把它写进输入框，然后关掉面板。
   *
   * 为什么是「带进对话」而不是「回复」：阶段 1 没有 thread，服务端也没有
   * 回复接口（那是设计文档里的阶段 2）。与其做一个假的回复按钮，
   * 不如接上这个宿主本来就擅长的动作 —— 你看到一个观点，
   * 想跟自己的 AI 聊聊它。
   */
  const bring = useCallback((card: SquareCard) => {
    const quoted = card.reasoning === undefined
      ? `「${card.claim}」`
      : `「${card.claim}」\n（${card.reasoning}）`
    inputActions.setDraft(`我在话题广场看到这个观点：\n\n${quoted}\n\n`)
    setOpen(false)
  }, [inputActions])

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => { setOpen(v => !v) }}
        title="话题广场"
        style={buttonStyle}
      >
        广场
      </button>
      {open && (
        <div style={panelStyle}>
          {/* hover 用 CSS 写。内联样式表达不了伪类，而这个包是外部插件，
              用不了宿主的 CSS module 管线，所以就地注入一条规则。 */}
          <style>{HOVER_CSS}</style>
          <div style={headerStyle}>
            <span>话题广场</span>
            <button type="button" onClick={() => { void load() }} style={linkStyle}>刷新</button>
          </div>
          {status.kind === 'loading' && <div style={hintStyle}>加载中…</div>}
          {status.kind === 'error' && (
            <div style={hintStyle}>
              连不上：{status.message}
              <div style={subHintStyle}>服务端没起来，或者没开 --dev-square</div>
            </div>
          )}
          {status.kind === 'ready' && status.cards.length === 0 && (
            <div style={hintStyle}>
              还没有卡片
              <div style={subHintStyle}>
                发布一条试试，或确认服务端开了 --dev-square
              </div>
            </div>
          )}
          {status.kind === 'ready' && status.cards.length > 0 && (
            <div style={subHintStyle}>点一张卡片，把它带进输入框</div>
          )}
          {status.kind === 'ready' && status.cards.map(card => (
            <button
              key={card.id}
              type="button"
              className={CARD_CLASS}
              onClick={() => { bring(card) }}
              style={cardStyle}
            >
              <div style={claimStyle}>{card.claim}</div>
              {card.reasoning !== undefined && (
                <div style={reasoningStyle}>{card.reasoning}</div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const CARD_CLASS = 'dsh-social-square-card'
const HOVER_CSS = `.${CARD_CLASS}:hover { background: var(--dsw-alias-fill-l2) !important; }`

// 内联样式而不是 CSS module：CSS module 需要宿主的构建管线参与，
// 而这个包是外部插件，产物是自己 esbuild 出来的单文件。
//
// ⚠️ 颜色一律用宿主的 --dsw-* 令牌，不要自己写死。
//    第一版我瞎猜了 --dsh-surface / --dsh-border 这种不存在的变量名，
//    于是 fallback 生效：深色底 + 继承来的深色字，在浅色主题下整块看不见。
//    真实令牌抄自 deepseek-harness/packages/client/ui-jobs 的 CSS module。
//
//    定位也照它：left: 0（不是 right: 0）——这个按钮在头部靠左，
//    右对齐会让面板整个飘到视口外面去。
const buttonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 28,
  padding: '3px 8px',
  border: 0,
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  lineHeight: '18px',
  cursor: 'pointer',
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 5px)',
  left: 0,
  zIndex: 100,
  boxSizing: 'border-box',
  width: 336,
  maxWidth: 'min(400px, calc(100vw - 32px))',
  maxHeight: 'min(420px, calc(100vh - 140px))',
  overflow: 'auto',
  padding: 8,
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 12,
  background: 'var(--dsw-specific-menu)',
  color: 'var(--dsw-alias-label-primary)',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary)',
  padding: '2px 4px 8px',
}

const linkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
  fontSize: 12,
  padding: 0,
}

const cardStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  border: 0,
  borderTop: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 6,
  background: 'transparent',
  padding: '8px 6px',
  cursor: 'pointer',
  font: 'inherit',
  transition: 'background 120ms ease',
}

const claimStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary)',
}

const reasoningStyle: React.CSSProperties = {
  fontSize: 12,
  marginTop: 4,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-secondary)',
}

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary)',
  padding: '12px 4px',
}

const subHintStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--dsw-alias-label-tertiary)',
  marginTop: 4,
}
