// Usage Stats: セッション数・メッセージ数・トークン数・利用日数・連続日数・よく使うモデルと
// 日ごとのヒートマップを /stats のペインに表示する。
// 記録は $.store に日ごとのキー（day:YYYY-MM-DD）で持つ。全セッションで共有される
const PANE = 'usage-stats'
const DAY_PREFIX = 'day:'
const HEATMAP_WEEKS = 20
const LEVEL_COLORS = ['#f3c6a5', '#ec9b6b', '#d97757', '#b5532f']
const RANGES = [
  { id: 'all', label: 'All', hotkey: 'a', days: Infinity },
  { id: '30d', label: '30d', hotkey: 'm', days: 30 },
  { id: '7d', label: '7d', hotkey: 'w', days: 7 },
]

// { 'YYYY-MM-DD': Day }。ペインを開いたときに store から読み直す
let days = {}
let tab = 'overview'
let range = 'all'

export function emptyDay() {
  return { sessions: [], messages: 0, tokens: 0, models: {} }
}

// ローカル時刻の YYYY-MM-DD
export function dateKey(date) {
  const p = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate())
}

function shiftDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n)
}

export function formatNumber(n) {
  if (n >= 1_000_000_000) return +(n / 1_000_000_000).toFixed(1) + 'B'
  if (n >= 1_000_000) return +(n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return +(n / 1_000).toFixed(1) + 'k'
  return String(n)
}

export function usageTokens(usage) {
  if (!usage) return 0
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  )
}

// 1ターン分を日の記録に足す。サブエージェントのターンはトークンだけ数える
export function addTurn(day, { usage, isMain }) {
  const tokens = usageTokens(usage)
  const models = { ...day.models }
  if (usage?.model) {
    const m = models[usage.model] ?? { turns: 0, tokens: 0 }
    models[usage.model] = { turns: m.turns + (isMain ? 1 : 0), tokens: m.tokens + tokens }
  }
  return { ...day, messages: day.messages + (isMain ? 1 : 0), tokens: day.tokens + tokens, models }
}

export function addSession(day, sessionId) {
  return day.sessions.includes(sessionId) ? day : { ...day, sessions: [...day.sessions, sessionId] }
}

// 期間内の集計。today は Date
export function summarize(allDays, today, rangeDays) {
  const from = rangeDays === Infinity ? '' : dateKey(shiftDays(today, -(rangeDays - 1)))
  const sessions = new Set()
  const models = {}
  let messages = 0
  let tokens = 0
  let activeDays = 0
  for (const [key, day] of Object.entries(allDays)) {
    if (key < from) continue
    day.sessions.forEach((s) => sessions.add(s))
    messages += day.messages
    tokens += day.tokens
    if (day.messages > 0 || day.sessions.length > 0) activeDays += 1
    for (const [name, m] of Object.entries(day.models)) {
      const cur = models[name] ?? { turns: 0, tokens: 0 }
      models[name] = { turns: cur.turns + m.turns, tokens: cur.tokens + m.tokens }
    }
  }
  const modelList = Object.entries(models)
    .map(([name, m]) => ({ name, ...m }))
    .sort((a, b) => b.turns - a.turns || b.tokens - a.tokens)
  return {
    sessions: sessions.size,
    messages,
    tokens,
    activeDays,
    streak: streak(allDays, today),
    favoriteModel: modelList[0]?.name ?? null,
    models: modelList,
  }
}

function isActive(day) {
  return !!day && (day.messages > 0 || day.sessions.length > 0)
}

// 今日（今日がまだなら昨日）から遡って連続で使った日数
export function streak(allDays, today) {
  let d = isActive(allDays[dateKey(today)]) ? today : shiftDays(today, -1)
  let n = 0
  while (isActive(allDays[dateKey(d)])) {
    n += 1
    d = shiftDays(d, -1)
  }
  return n
}

// 7行（日〜土）× weeks 列。最後の列が今日を含む週。値は 0〜4 の濃さ、未来は null
export function heatmap(allDays, today, weeks) {
  const start = shiftDays(today, -today.getDay() - (weeks - 1) * 7)
  const values = []
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const date = shiftDays(start, w * 7 + d)
      values.push(date > today ? null : (allDays[dateKey(date)]?.messages ?? 0))
    }
  }
  const max = Math.max(1, ...values.filter((v) => v !== null))
  const rows = []
  for (let d = 0; d < 7; d++) {
    const row = []
    for (let w = 0; w < weeks; w++) {
      const v = values[w * 7 + d]
      row.push(v === null ? null : v === 0 ? 0 : Math.max(1, Math.ceil((v / max) * 4)))
    }
    rows.push(row)
  }
  return rows
}

async function loadDays($) {
  const keys = (await $.store.keys()).filter((k) => k.startsWith(DAY_PREFIX))
  const next = {}
  for (const key of keys) next[key.slice(DAY_PREFIX.length)] = (await $.store.get(key)) ?? emptyDay()
  days = next
}

// 今日の記録を書き換える。他のセッションの書き込みを消さないよう、直前に読み直す
async function updateToday($, fn) {
  const key = dateKey(new Date(await $.clock.now()))
  const current = (await $.store.get(DAY_PREFIX + key)) ?? emptyDay()
  const next = fn(current)
  await $.store.set(DAY_PREFIX + key, next)
  days = { ...days, [key]: next }
  $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const sessionId = await $.session.id()
    await updateToday($, (day) => addSession(day, sessionId))
    await $.command.register({ name: 'stats', description: '利用統計のパネルを開く', immediate: true })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.usage || !e.agentId) {
      await updateToday($, (day) => addTurn(day, { usage: e.usage, isMain: !e.agentId }))
    }
    return result
  })

  on('command.run', { command: 'stats' }, async ($) => {
    await loadDays($)
    await $.ui.open({ id: PANE, title: 'Usage stats', focus: true, closeOnEscape: true })
    return {}
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const redraw = () => $.ui.invalidate('ui.render')
    const today = new Date(await $.clock.now())
    const width = e.props.bodyColumns ?? 80
    const r = RANGES.find((x) => x.id === range)
    const s = summarize(days, today, r.days)

    const tabButton = (id, label, hotkey) =>
      Button({ key: 'tab-' + id, label, hotkey, plain: true, dimColor: tab !== id, onPress: () => { tab = id; redraw() } })
    const rangeButton = (x) =>
      Button({ key: 'range-' + x.id, label: x.label, hotkey: x.hotkey, plain: true, dimColor: range !== x.id, onPress: () => { range = x.id; redraw() } })

    const header = Box({
      flexDirection: 'row',
      justifyContent: 'space-between',
      children: [
        Box({ flexDirection: 'row', columnGap: 2, children: [tabButton('overview', 'Overview', '1'), tabButton('models', 'Models', '2')] }),
        Box({ flexDirection: 'row', columnGap: 2, children: RANGES.map(rangeButton) }),
      ],
    })

    const cardWidth = Math.max(18, Math.floor((width - 4) / 3))
    const card = (label, value) =>
      Box({
        key: 'card-' + label,
        flexDirection: 'column',
        width: cardWidth,
        borderStyle: 'round',
        paddingX: 1,
        children: [Text({ dimColor: true, children: [label] }), Text({ bold: true, wrap: 'truncate-end', children: [value] })],
      })
    const cardRow = (items) => Box({ flexDirection: 'row', children: items.map(([l, v]) => card(l, v)) })

    const weeks = Math.max(4, Math.min(HEATMAP_WEEKS, Math.floor((width - 2) / 2)))
    const grid = heatmap(days, today, weeks)
    const cell = (level) =>
      level === null
        ? Text({ children: ['  '] })
        : level === 0
          ? Text({ dimColor: true, children: ['· '] })
          : Text({ color: LEVEL_COLORS[level - 1], children: ['■ '] })
    const heat = Box({
      flexDirection: 'column',
      children: [
        ...grid.map((row) => Text({ children: row.map(cell) })),
        Text({ dimColor: true, children: ['Less ', ...LEVEL_COLORS.map((c) => Text({ color: c, children: ['■ '] })), 'More'] }),
      ],
    })

    const overview = [
      cardRow([
        ['Sessions', formatNumber(s.sessions)],
        ['Messages', formatNumber(s.messages)],
        ['Total tokens', formatNumber(s.tokens)],
      ]),
      cardRow([
        ['Active days', String(s.activeDays)],
        ['Streak', s.streak + (s.streak === 1 ? ' day' : ' days')],
        ['Favorite model', s.favoriteModel ?? '—'],
      ]),
      Text({ children: [' '] }),
      heat,
    ]

    const maxTurns = Math.max(1, ...s.models.map((m) => m.turns))
    const barWidth = Math.max(5, Math.min(30, width - 50))
    const models = s.models.length
      ? s.models.map((m) =>
          Box({
            key: 'model-' + m.name,
            flexDirection: 'row',
            columnGap: 2,
            children: [
              Text({ wrap: 'truncate-end', children: [m.name.padEnd(28).slice(0, 28)] }),
              Text({ color: LEVEL_COLORS[2], children: ['█'.repeat(Math.max(1, Math.round((m.turns / maxTurns) * barWidth)))] }),
              Text({ dimColor: true, children: [m.turns + ' turns · ' + formatNumber(m.tokens) + ' tokens'] }),
            ],
          }),
        )
      : [Text({ dimColor: true, children: ['この期間の記録はまだありません'] })]

    return Box({
      flexDirection: 'column',
      children: [header, Text({ children: [' '] }), ...(tab === 'overview' ? overview : models)],
    })
  })
}
