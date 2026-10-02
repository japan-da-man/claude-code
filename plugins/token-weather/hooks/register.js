// Token Weather: コンテキストの埋まり具合を天気にたとえて、プロンプトの上に表示する

// 直近ターンの使用率（%）。スパークラインに使う
const HISTORY_SIZE = 12
let history = []
// 最新の値: { tokens, window, percent }
let context = null
// 直前のターンで増減したトークン数。比べる前の値がないうちは null
let delta = null
// /weather で表示を切り替える
let hidden = false

// 埋まり具合ごとの天気。上から順に、percent が max 未満なら採用
export const FORECASTS = [
  { max: 30, icon: '☀', label: 'Clear', color: '#e8b931' },
  { max: 50, icon: '⛅', label: 'Partly cloudy', color: '#c9b46b' },
  { max: 70, icon: '☁', label: 'Cloudy', color: '#9aa0a6' },
  { max: 85, icon: '🌧', label: 'Rain', color: '#5b9bd5', hint: '/compact を検討' },
  { max: Infinity, icon: '⛈', label: 'Storm', color: '#e5534b', hint: '/compact 推奨' },
]

export function forecast(percent) {
  return FORECASTS.find((f) => percent < f.max)
}

// 9000 → 9k, 1000000 → 1M
export function formatTokens(n) {
  if (n >= 1_000_000) return +(n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return Math.round(n / 1_000) + 'k'
  return String(n)
}

// 12000 → +12k, -80000 → −80k（compact などで減ったとき）
export function formatDelta(n) {
  if (n === 0) return '±0'
  return (n > 0 ? '+' : '−') + formatTokens(Math.abs(n))
}

const BARS = '▁▂▃▄▅▆▇█'

export function sparkline(values) {
  return values.map((p) => BARS[Math.min(BARS.length - 1, Math.floor((p / 100) * BARS.length))]).join('')
}

// session.measure / usage() の context を取り込む。使用率が動いたら履歴に積む
function record(next) {
  if (typeof next?.percent !== 'number') {
    context = { ...context, window: next?.window }
    return
  }
  const tokens = next.tokens ?? 0
  // 起動直後やリロード直後は、読み込んだ値と同じ計測がもう一度届く。ターンではないので数えない
  if (tokens === context?.tokens && next.percent === context?.percent) return
  delta = typeof context?.tokens === 'number' ? tokens - context.tokens : null
  context = { tokens, window: next.window, percent: next.percent }
  history = [...history, next.percent].slice(-HISTORY_SIZE)
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    hidden = (await $.store.get('hidden')) === true
    record((await $.session.usage()).context)
    await $.command.register({ name: 'weather', description: 'Token Weather の表示を切り替える', immediate: true })
    return next(e)
  })

  // ターンごと（と使用量が動いたとき）に届く計測値
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      record(e.context)
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // /clear などで会話がリセットされたら履歴も消す
  on('session.end', async ($, e, next) => {
    history = []
    context = null
    delta = null
    return next(e)
  })

  on('command.run', { command: 'weather' }, async ($) => {
    hidden = !hidden
    $.ui.invalidate('ui.render')
    await $.store.set('hidden', hidden)
    return { text: hidden ? 'Token Weather を非表示にしました' : 'Token Weather を表示しました' }
  })

  // プロンプト上の帯に1行描く
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (hidden || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)

    const percent = context?.percent ?? 0
    const f = forecast(percent)
    const usage = context?.window
      ? formatTokens(context.tokens ?? 0) + ' / ' + formatTokens(context.window)
      : '—'

    const children = [
      Text({ color: f.color, bold: true, children: [f.icon + ' ' + f.label] }),
      Text({ children: [percent + '% of context'] }),
      Text({ dimColor: true, children: [usage] }),
    ]
    if (history.length) {
      children.push(
        Text({
          dimColor: true,
          children: [
            'last turns ',
            Text({ color: f.color, children: [sparkline(history)] }),
            ...(delta === null ? [] : [' ' + formatDelta(delta)]),
          ],
        }),
      )
    }
    if (f.hint) children.push(Text({ color: f.color, children: [f.hint] }))

    const line = Box({ flexDirection: 'row', columnGap: 2, children })
    // 他の mod が帯に描くものも残す
    const rest = await next(e)
    return rest ? Box({ flexDirection: 'column', children: [line, rest] }) : line
  })
}
