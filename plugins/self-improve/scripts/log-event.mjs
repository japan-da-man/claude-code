// 信号を生ログに 1 行追記する（UserPromptSubmit / PostToolUseFailure / PostToolUse）。
// async で動くので、何も出力せず、作業を止めない。自動改善のセッションでは何も記録しない。
import { mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { heartbeat, hookContext, isLocked, isMain, iso, logEvent, readHookInput, readJson, sessionDir, writeJson } from './lib/core.mjs'
import { isHarnessNoteOnly, isNonChanging } from './lib/bash.mjs'

// 人の訂正を表す言い回し。直前のターンがあるときだけ調べる。
const CORRECTIONS = [
  '違う', '違います', 'ちがう', 'そうじゃな', 'そうではな', '戻して', '元に戻', 'やり直', '間違', 'まちが',
  '言ったのに', '言ったよね', '頼んでない', '頼んでいない', '勝手に',
]
const CORRECTIONS_EN = /\b(?:no[,.!]|(?:wrong|revert|undo|that'?s not|not what i|i said|i didn'?t ask|you (?:broke|missed|forgot))\b)/i

export function correctionWords(prompt, extra = []) {
  const text = String(prompt ?? '')
  if (!text.trim() || text.trimStart().startsWith('/')) return []
  const found = [...CORRECTIONS, ...extra].filter((word) => text.includes(word))
  const english = CORRECTIONS_EN.exec(text)
  if (english) found.push(english[0].toLowerCase())
  return [...new Set(found)]
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

function target(ctx, input) {
  const ti = input.tool_input ?? {}
  if (input.tool_name === 'Bash') return String(ti.command ?? '').slice(0, 200)
  const path = ti.file_path ?? ti.notebook_path
  if (typeof path === 'string' && path) {
    const rel = relative(ctx.repo.root, path)
    return rel.startsWith('..') ? path : rel
  }
  return null
}

function onPrompt(ctx, input) {
  heartbeat(ctx, 'record')
  const dir = sessionDir(ctx)
  mkdirSync(dir, { recursive: true })
  // 訂正は次のターンの依頼文に現れるので、直前のターン（on-stop が残したもの）があるときだけ調べる。
  const previous = readJson(join(dir, 'stop.json'))?.last_turn ?? null
  const words = previous ? correctionWords(input.prompt, ctx.config.correction_words) : []
  // 依頼文は、事象メモを作るために 1 ターン分だけ持っておく。次のターンで上書きされる。
  writeJson(join(dir, 'turn.json'), { prompt_id: input.prompt_id ?? null, prompt: String(input.prompt ?? ''), at: iso(), correction: words })
  logEvent(ctx, { type: 'prompt', prompt_id: input.prompt_id ?? null })
  if (words.length) logEvent(ctx, { type: 'human_correction', prompt_id: input.prompt_id ?? null, words })
}

function onFailure(ctx, input) {
  if (input.tool_name === 'Bash' && isHarnessNoteOnly(input.tool_input?.command)) return
  // error の形式はツールごとに違うので、1 行目だけを残す。
  const first = String(input.error ?? '').split('\n').find((line) => line.trim()) ?? ''
  logEvent(ctx, {
    type: 'tool_failure',
    prompt_id: input.prompt_id ?? null,
    tool: input.tool_name ?? null,
    error: first.trim().slice(0, 300),
    is_interrupt: Boolean(input.is_interrupt),
    target: target(ctx, input),
    ...(input.agent_id ? { agent_id: input.agent_id } : {}),
  })
}

// 「このターンで変更あり」の印。harness-note の実行と、読むだけのコマンドは数えない。
function onToolUse(ctx, input) {
  const tool = input.tool_name
  if (tool === 'Bash') {
    if (isNonChanging(input.tool_input?.command)) return
  } else if (!FILE_TOOLS.has(tool)) {
    return
  }
  // 印として残すのは、ツールの名前と、ファイルならそのパスだけ（Bash のコマンドは残さない）。
  logEvent(ctx, { type: 'change', prompt_id: input.prompt_id ?? null, tool, target: tool === 'Bash' ? null : target(ctx, input) })
}

function main() {
  const input = readHookInput()
  const ctx = hookContext(input)
  if (!ctx || !ctx.sessionId) return
  if (isLocked(ctx)) return
  if (input.hook_event_name === 'UserPromptSubmit') onPrompt(ctx, input)
  else if (input.hook_event_name === 'PostToolUseFailure') onFailure(ctx, input)
  else if (input.hook_event_name === 'PostToolUse') onToolUse(ctx, input)
}

if (isMain(import.meta.url)) {
  try {
    main()
  } catch {
    // 記録に失敗しても、作業は止めない
  }
}
