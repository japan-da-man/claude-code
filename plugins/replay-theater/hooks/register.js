// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Replay Theater: records the file edits Claude makes in a turn, then lets you
// step through them in a pane, one diff at a time.
// Based on mods/replay-theater in anthropics/claude-code-playground (Apache-2.0, see LICENSE).
//
// japan-da-man による変更:
// - 記録したステップと見ている位置を $.state に置く（プラグインを読み込み直しても消えない）
// - 成功した編集だけ記録する（拒否されたり失敗したりした編集は記録しない）
// - 帯に他の mod が描くものを残す（Token Weather などと共存する）
// - 描画サイトの値は e.props から読む

import { atom, read, update } from 'claude-code'

const PANE_ID = 'replay-theater'
const MAX_DIFF_LINES = 12
const MAX_LCS_LINES = 400
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

// 直前に編集があったターンのステップと、ペインで見ている位置
const replayAtom = atom({ plugin: 'replay-theater', key: 'replay' }, { steps: [], index: 0 })
// 今のターンのステップ（ターンが終わったら replay に移す）
let pending = []
// ペインを開いているか。狭い画面でペインを置けないときは帯に描く
const view = { isOpen: false, inBand: false }

export function relPath(cwd, path) {
  if (!path) return '(unknown file)'
  if (cwd && path.startsWith(cwd + '/')) return path.slice(cwd.length + 1)
  return path
}

function splitLines(text) {
  if (text === undefined || text === null || text === '') return []
  const lines = String(text).split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

// 行単位の差分。小さいものは LCS で変わっていない行も文脈として残し、大きいものは全部削除→全部追加にする
export function diffLines(oldText, newText) {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return [...a.map((t) => ({ op: '-', t })), ...b.map((t) => ({ op: '+', t }))]
  }
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  }
  const out = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', t: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', t: a[i++] })
    else out.push({ op: '+', t: b[j++] })
  }
  while (i < n) out.push({ op: '-', t: a[i++] })
  while (j < m) out.push({ op: '+', t: b[j++] })
  return trimContext(out)
}

// 変更の前後 1 行だけ文脈を残す。長いファイルの Write でも変わった行が見える
export function trimContext(lines) {
  if (!lines.some((l) => l.op !== ' ')) return lines.slice(0, MAX_DIFF_LINES)
  const changed = (l) => l !== undefined && l.op !== ' '
  const keep = lines.map((l, k) => changed(l) || changed(lines[k - 1]) || changed(lines[k + 1]))
  const out = []
  let skipped = false
  lines.forEach((l, k) => {
    if (keep[k]) {
      if (skipped && out.length) out.push({ op: '~', t: '⋯' })
      out.push(l)
      skipped = false
    } else {
      skipped = true
    }
  })
  return out
}

export function countChanges(diff) {
  let add = 0
  let del = 0
  for (const l of diff) {
    if (l.op === '+') add++
    else if (l.op === '-') del++
  }
  return { add, del }
}

// 1 回のツール呼び出しを 1 つ以上のステップにする。before は Write の前のファイルの中身
export function stepsFor(e, cwd, before) {
  const file = relPath(cwd, e.file_path)
  if (e.tool === 'Edit') {
    return [{ tool: 'Edit', file, diff: diffLines(e.old_string, e.new_string), note: e.replace_all ? 'replace all' : '' }]
  }
  if (e.tool === 'MultiEdit' && Array.isArray(e.edits)) {
    return e.edits.map((ed, k) => ({ tool: 'MultiEdit', file, diff: diffLines(ed.old_string, ed.new_string), note: `edit ${k + 1} of ${e.edits.length}` }))
  }
  if (e.tool === 'Write') {
    return [{ tool: 'Write', file, diff: diffLines(before ?? '', e.content), note: before === null ? 'new file' : 'rewrite' }]
  }
  return []
}

// Write の前のファイルの中身。ないか読めなければ null（新しいファイルとして扱う）
async function readBefore($, path) {
  try {
    return path && (await $.fs.exists(path)) ? await $.fs.read(path) : null
  } catch {
    return null
  }
}

export function hintText(n) {
  return `▶ Replay: ${n} edit${n === 1 ? '' : 's'} (press r)`
}

async function openReplay($) {
  const { steps } = await read($, replayAtom)
  if (!steps.length) return false
  await update($, replayAtom, (s) => ({ ...s, index: 0 }))
  view.isOpen = true
  // ペインはほかにキーボードを持つものがないときだけキーを受け取る。先に帯を消してから開く
  $.ui.invalidate('ui.render')
  await $.clock.sleep(200)
  const rows = Math.min(MAX_DIFF_LINES + 8, 22)
  const placed = await $.ui.open({ id: PANE_ID, title: 'Replay Theater', focus: true, closeOnEscape: true, rows, columns: 58 })
  // ペインを置く場所がない（狭いターミナル）ときは帯に描く
  view.inBand = placed?.isPlaced === false
  $.ui.invalidate('ui.render')
  return true
}

// 1 ステップずつ見る画面。ペインに描くか、ペインを置けないときは帯に描く
async function replayView($, e, inBand) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const { steps, index } = await read($, replayAtom)
  const maxDiff = inBand ? Math.max(3, Math.min(MAX_DIFF_LINES, (e.props.maxRows || 20) - 7)) : MAX_DIFF_LINES
  const total = steps.length
  if (!total) return Text({ dimColor: true, children: 'No edits to replay.' })
  const k = Math.max(0, Math.min(index, total - 1))
  const step = steps[k]
  const width = Math.max(40, (e.props.bodyColumns || 100) - 4)
  const { add, del } = countChanges(step.diff)
  const shown = step.diff.slice(0, maxDiff)

  const diffRows = shown.map((l, n) => {
    const color = l.op === '+' ? 'green' : l.op === '-' ? 'red' : undefined
    const line = `${l.op === '~' ? ' ' : l.op} ${l.t}`.slice(0, width)
    return Text({ key: `d${n}`, color, dimColor: l.op === ' ' || l.op === '~', wrap: 'truncate-end', children: line })
  })
  if (step.diff.length > maxDiff) diffRows.push(Text({ key: 'more', dimColor: true, children: `  … ${step.diff.length - maxDiff} more lines` }))
  if (!shown.length) diffRows.push(Text({ key: 'empty', dimColor: true, children: '  (no line changes)' }))

  // ステップの並び。今のステップを反転表示する
  const strip = steps.map((s, n) => Text({ key: `s${n}`, inverse: n === k, color: n === k ? 'cyan' : undefined, dimColor: n !== k, children: ` ${n + 1} ` }))

  const go = (to) => update($, replayAtom, (s) => ({ ...s, index: Math.max(0, Math.min(to, s.steps.length - 1)) }))
  const close = () => {
    view.isOpen = false
    if (!view.inBand) $.ui.close({ id: PANE_ID })
    view.inBand = false
    $.ui.invalidate('ui.render')
  }

  return Box({
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: 'magenta',
    paddingX: 1,
    children: [
      Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        children: [Text({ bold: true, color: 'magenta', children: '▶ Replay Theater' }), Text({ bold: true, children: `step ${k + 1} of ${total}` })],
      }),
      Box({ flexDirection: 'row', children: strip }),
      Text({ bold: true, color: 'cyan', wrap: 'truncate-start', children: step.file }),
      Box({
        flexDirection: 'row',
        gap: 2,
        children: [
          Text({ dimColor: true, children: `${step.tool}${step.note ? ' · ' + step.note : ''}` }),
          Text({ color: 'green', children: `+${add}` }),
          Text({ color: 'red', children: `-${del}` }),
        ],
      }),
      Box({ flexDirection: 'column', marginTop: 1, children: diffRows }),
      Box({
        flexDirection: 'row',
        gap: 2,
        marginTop: 1,
        children: [
          Button({ key: 'prev', label: '◀ Prev', hotkey: 'p', onPress: () => go(k - 1) }),
          Button({ key: 'next', label: 'Next ▶', hotkey: 'n', autoFocus: true, onPress: () => go(k + 1) }),
          Button({ key: 'close', label: 'Close', hotkey: 'c', onPress: close }),
        ],
      }),
    ],
  })
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'replay', description: 'Replay Theater: step through the last turn\'s file edits', immediate: true })
    return r
  })

  on('command.run', { command: 'replay' }, async ($) => {
    const opened = await openReplay($)
    const { steps } = await read($, replayAtom)
    return { text: opened ? `Replay Theater: ${steps.length} edits` : 'Replay Theater: no edits in the last turn.' }
  })

  // 編集を記録して、そのまま実行させる。記録が失敗しても編集は止めない。成功した編集だけ残す
  on('tool.call', async ($, e, next) => {
    if (!EDIT_TOOLS.has(e.tool)) return next(e)
    let steps = []
    try {
      const before = e.tool === 'Write' ? await readBefore($, e.file_path) : null
      steps = stepsFor(e, await $.session.cwd(), before)
    } catch {
      steps = []
    }
    const r = await next(e)
    if (r && !r.deny && !r.isError) pending.push(...steps)
    return r
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) pending = []
    return next(e)
  })

  // メインのターンが終わったら、そのターンの編集を replay にする。編集のないターンでは前の replay を残す
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || !pending.length) return r
    const steps = pending
    pending = []
    await update($, replayAtom, () => ({ steps, index: 0 }))
    return r
  })

  // プロンプトの上: ヒントとペインを開くボタン
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (view.isOpen && view.inBand) return replayView($, e, true)
    const { steps } = await read($, replayAtom)
    if (!steps.length || view.isOpen || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const line = Box({
      flexDirection: 'row',
      gap: 2,
      paddingX: 1,
      children: [
        Text({ color: 'magenta', bold: true, children: hintText(steps.length) }),
        Button({ key: 'open-replay', label: 'Replay', hotkey: 'r', onPress: () => openReplay($) }),
      ],
    })
    // 他の mod が帯に描くものも残す
    const rest = await next(e)
    return rest ? Box({ flexDirection: 'column', children: [line, rest] }) : line
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    return replayView($, e, false)
  })

  // Esc などでペインが閉じられたら、こちらの状態も合わせる
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE_ID) view.isOpen = false
    $.ui.invalidate('ui.render')
    return next(e)
  })
}
