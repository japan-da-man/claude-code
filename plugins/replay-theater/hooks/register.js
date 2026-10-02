// Replay Theater: ターンの中で Claude が行ったファイル編集を記録し、ペインで 1 件ずつ差分をたどる
import { atom, read, update } from 'claude-code'

const PANE = 'replay-theater'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const CONTEXT = 2
const MAX_DIFF_LINES = 400
const MAX_LCS_LINES = 600
const PINK = '#d6609a'
const COLORS = { add: '#3fb950', del: '#e5534b', path: '#4c9aff' }

// 直前のターンの編集。$.state なのでプラグインを読み込み直しても消えない
const replay = atom({ plugin: 'replay-theater', key: 'replay' }, { edits: [], step: 0 })
// 今のターンの編集（ターンが終わったら replay に移す）
let pending = []

// --- 差分（純粋関数。テストから直接呼ぶ） ---

const splitLines = (text) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

// 行単位の LCS で差分を取り、{ kind: 'add' | 'del' | 'ctx', text } の並びを返す
export function diffLines(before, after) {
  const a = splitLines(before)
  const b = splitLines(after)
  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return [...a.map((text) => ({ kind: 'del', text })), ...b.map((text) => ({ kind: 'add', text }))]
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: a[i++] })
    } else {
      out.push({ kind: 'add', text: b[j++] })
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] })
  while (j < b.length) out.push({ kind: 'add', text: b[j++] })
  return out
}

// 変更の前後 CONTEXT 行だけ残し、飛ばしたところに gap を入れる
export function withContext(lines, context = CONTEXT) {
  const keep = lines.map(() => false)
  lines.forEach((l, k) => {
    if (l.kind === 'ctx') return
    for (let d = -context; d <= context; d++) if (lines[k + d]) keep[k + d] = true
  })
  const out = []
  let skipped = false
  lines.forEach((l, k) => {
    if (keep[k]) {
      if (skipped && out.length) out.push({ kind: 'gap', text: '…' })
      out.push(l)
      skipped = false
    } else {
      skipped = true
    }
  })
  return out.slice(0, MAX_DIFF_LINES)
}

// 1 回分の編集を記録する形にまとめる
export function makeEdit(path, tool, before, after) {
  const all = diffLines(before, after)
  return {
    path,
    tool,
    lines: withContext(all),
    added: all.filter((l) => l.kind === 'add').length,
    removed: all.filter((l) => l.kind === 'del').length,
  }
}

// セッションの作業フォルダから見た相対パスで表示する
export function relative(path, cwd) {
  const base = cwd.replace(/\/+$/, '') + '/'
  return path.startsWith(base) ? path.slice(base.length) : path
}

async function readOrEmpty($, path) {
  try {
    return (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  } catch {
    return ''
  }
}

async function openPane($) {
  await $.ui.open({ id: PANE, title: 'Replay Theater', focus: true, closeOnEscape: true })
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'replay', description: '直前のターンのファイル編集を 1 件ずつ見る', immediate: true })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) pending = []
    return next(e)
  })

  // 編集が成功したものだけ記録する。サブエージェントの編集も含める
  on('tool.call', async ($, e, next) => {
    if (!EDIT_TOOLS.has(e.tool)) return next(e)
    const before = e.tool === 'Write' ? await readOrEmpty($, e.file_path) : null
    const r = await next(e)
    if (!r || r.deny || r.isError) return r
    const path = relative(e.file_path, await $.session.cwd())
    if (e.tool === 'Edit') pending.push(makeEdit(path, 'Edit', e.old_string, e.new_string))
    else if (e.tool === 'Write') pending.push(makeEdit(path, 'Write', before, e.content))
    else for (const edit of e.edits ?? []) pending.push(makeEdit(path, 'Edit', edit.old_string, edit.new_string))
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      const edits = pending
      pending = []
      await update($, replay, () => ({ edits, step: 0 }))
    }
    return r
  })

  on('command.run', { command: 'replay' }, async ($) => {
    const { edits } = await read($, replay)
    if (!edits.length) return { text: '直前のターンにはファイル編集がありません' }
    await openPane($)
    return {}
  })

  // プロンプトの上: ▶ Replay: N edits (press r)  [Replay]
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { edits } = await read($, replay)
    const rest = await next(e)
    if (!edits.length || e.props.hasSurvey) return rest
    const { Box, Text, Button } = $.ui.resolve(e)
    const line = Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Text({ color: PINK, children: ['▶ Replay: ' + edits.length + (edits.length === 1 ? ' edit' : ' edits') + ' (press r)'] }),
        Button({ key: 'replay-open', label: 'Replay', hotkey: 'r', onPress: () => openPane($) }),
      ],
    })
    return rest ? Box({ flexDirection: 'column', children: [line, rest] }) : line
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const { edits, step: rawStep } = await read($, replay)
    if (!edits.length) return Text({ dimColor: true, children: ['直前のターンにはファイル編集がありません'] })
    const step = Math.min(rawStep, edits.length - 1)
    const edit = edits[step]
    const go = (to) => update($, replay, (s) => ({ ...s, step: Math.max(0, Math.min(s.edits.length - 1, to)) }))
    const room = Math.max(8, (e.props.scroll?.bodyRows ?? 30) - 10)
    const shown = edit.lines.slice(0, room)

    const numbers = edits.map((_, k) =>
      Text({ key: 'n-' + k, inverse: k === step, color: k === step ? COLORS.path : undefined, children: [String(k + 1)] }),
    )
    const lineColor = { add: COLORS.add, del: COLORS.del }
    const prefix = { add: '+ ', del: '- ', ctx: '  ', gap: '  ' }

    return Box({
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: PINK,
      paddingX: 1,
      children: [
        Box({
          flexDirection: 'row',
          justifyContent: 'space-between',
          children: [Text({ bold: true, color: PINK, children: ['▶ Replay Theater'] }), Text({ bold: true, children: ['step ' + (step + 1) + ' of ' + edits.length] })],
        }),
        Box({ flexDirection: 'row', columnGap: 1, children: numbers }),
        Text({ bold: true, color: COLORS.path, wrap: 'truncate-middle', children: [edit.path] }),
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Text({ children: [edit.tool] }),
            Text({ color: COLORS.add, children: ['+' + edit.added] }),
            Text({ color: COLORS.del, children: ['-' + edit.removed] }),
          ],
        }),
        Text({ children: [' '] }),
        ...shown.map((l, k) =>
          Text({ key: 'l-' + k, color: lineColor[l.kind], dimColor: l.kind === 'ctx' || l.kind === 'gap', wrap: 'truncate-end', children: [prefix[l.kind] + l.text] }),
        ),
        ...(edit.lines.length > shown.length ? [Text({ dimColor: true, children: ['… ほか ' + (edit.lines.length - shown.length) + ' 行'] })] : []),
        Text({ children: [' '] }),
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Button({ key: 'prev', label: '◀ Prev', hotkey: 'p', onPress: () => go(step - 1) }),
            Button({ key: 'next', label: 'Next ▶', hotkey: 'n', autoFocus: true, onPress: () => go(step + 1) }),
            Button({ key: 'close', label: 'Close', hotkey: 'c', onPress: () => $.ui.close({ id: PANE }) }),
          ],
        }),
      ],
    })
  })
}
