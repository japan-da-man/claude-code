// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Token Weather: a live forecast of the context window, above the prompt.
// Based on mods/token-weather in anthropics/claude-code-playground (Apache-2.0, see LICENSE).
//
// japan-da-man による変更:
// - 計測値を $.state に置く（プラグインを読み込み直しても履歴が消えない。/clear などでは初期化される）
// - 前回と同じ計測値は追加しない（読み込み直した直後に同じ値が届いても二重に数えない）
// - 帯に他の mod が描くものを残す（Replay Theater などと共存する）
// - /weather で表示を切り替える
// - 描画サイトの値は e.props から読む

import { atom, read, update } from 'claude-code'

const HISTORY = 12
const BARS = '▁▂▃▄▅▆▇█'

// 使用率ごとの天気。絵文字ではなく 1 文字幅の記号を使う（どのターミナルのフォントでも揃う）
export const FORECAST = [
  { upTo: 25, icon: '☀', word: 'Clear', color: 'yellow' },
  { upTo: 50, icon: '☁', word: 'Cloudy', color: 'cyan' },
  { upTo: 75, icon: '☂', word: 'Showers', color: 'blue' },
  { upTo: 90, icon: '☇', word: 'Storm', color: 'magenta' },
  { upTo: Infinity, icon: '↯', word: 'Compact soon', color: 'red' },
]

// 計測値 { tokens, window, percent } の並び（古い順）
const readingsAtom = atom({ plugin: 'token-weather', key: 'readings' }, [])
// /weather で表示を切り替える
let hidden = false

// 計測値を 1 つ足した次の並びを返す。足すものがなければ同じ配列を返す
export function addReading(readings, context) {
  if (!context || !context.window) return readings
  const tokens = context.tokens ?? 0
  const percent = Math.round(context.percent ?? (tokens / context.window) * 100)
  // 最初の応答の前の 0 の計測は、本物の計測が来たら外す
  const kept = readings.filter((r) => r.tokens > 0)
  const last = kept[kept.length - 1]
  if (last && last.tokens === tokens && last.window === context.window) return readings
  if (tokens === 0 && readings.length) return readings
  return [...kept, { tokens, window: context.window, percent }].slice(-HISTORY)
}

export function forecastFor(percent) {
  return FORECAST.find((f) => percent < f.upTo) ?? FORECAST[FORECAST.length - 1]
}

// バーの高さは表示中で一番多いターンを基準にする。使用率が低くても増え方が見える
export function chart(readings) {
  const top = Math.max(...readings.map((r) => r.tokens), 1)
  return readings.map((r) => BARS[Math.min(BARS.length - 1, Math.floor((r.tokens / top) * (BARS.length - 1)))]).join('')
}

export function trendWord(readings) {
  if (readings.length < 2) return ''
  const delta = readings[readings.length - 1].tokens - readings[readings.length - 2].tokens
  if (delta > 0) return `▲ +${short(delta)} last turn`
  if (delta < 0) return `▼ ${short(-delta)} last turn`
  return 'steady'
}

export function short(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`
  return String(n)
}

async function takeReading($) {
  try {
    const { context } = await $.session.usage()
    // $.state に書くと、それを読んでいる帯は自動で描き直される
    await update($, readingsAtom, (rs) => addReading(rs, context))
  } catch {
    // このターンは計測なし。帯は前回の値のまま
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    hidden = (await $.store.get('hidden')) === true
    await takeReading($)
    await $.command.register({ name: 'weather', description: 'Token Weather の表示を切り替える', immediate: true })
    return result
  })

  // メインのターンが終わるたびに計測する。サブエージェントのターンは数えない
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) await takeReading($)
    return result
  })

  on('command.run', { command: 'weather' }, async ($) => {
    hidden = !hidden
    $.ui.invalidate('ui.render')
    await $.store.set('hidden', hidden)
    return { text: hidden ? 'Token Weather を非表示にしました' : 'Token Weather を表示しました' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const readings = await read($, readingsAtom)
    if (hidden || e.props.hasSurvey || readings.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const line = band(Box, Text, readings, e.props.bodyColumns ?? 80)
    // 他の mod が帯に描くものも残す
    const rest = await next(e)
    return rest ? Box({ flexDirection: 'column', children: [line, rest] }) : line
  })
}

function band(Box, Text, readings, columns) {
  const now = readings[readings.length - 1]
  const f = forecastFor(now.percent)
  const trend = trendWord(readings)
  const parts = [
    Text({ color: f.color, bold: true, children: `${f.icon}  ${f.word}` }),
    Text({ children: `  ${now.percent}% of context` }),
    Text({ dimColor: true, children: `  ${short(now.tokens)} / ${short(now.window)}` }),
  ]
  // 狭い画面ではグラフと増減を省く
  if (columns >= 60) {
    parts.push(Text({ dimColor: true, children: '   last turns ' }))
    parts.push(Text({ color: f.color, children: chart(readings) }))
    if (trend) parts.push(Text({ dimColor: true, children: `  ${trend}` }))
  }
  return Box({ flexDirection: 'row', paddingX: 1, children: parts })
}
