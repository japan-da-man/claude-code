// 事象メモを作る。振り返りの材料を、ターンの終わりにファイルへまとめたもの。
// スクリプトが機械的に組み立てる（LLM は使わない）。要約と解釈は、振り返りのときに行う。
// 依頼文と応答の全文が入るので、リポジトリの外に置き、信号のあったターンに限り、期限で消す。
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DAY_MS, iso, listFiles, now, safeId, sha, stamp, writeFileAtomic } from './lib/core.mjs'

export function episodeId(sessionId, turnKey, startedAt) {
  const at = startedAt ? new Date(startedAt) : now()
  return `ep-${stamp(Number.isNaN(at.getTime()) ? now() : at)}-${safeId(sessionId).slice(0, 8)}-${sha(turnKey, 6)}`
}

const SIGNAL_LABELS = {
  tool_failure: 'ツールの失敗',
  human_correction: '人の訂正',
  guard_denied: 'ガードの拒否',
  verify_failed: '検証の失敗',
}

function describe(event) {
  const label = SIGNAL_LABELS[event.type] ?? event.type
  if (event.type === 'tool_failure') {
    return `- ${label}：${event.tool ?? '?'}${event.target ? `（${event.target}）` : ''} — ${event.error || '（エラー文なし）'}${event.is_interrupt ? '［中断］' : ''}`
  }
  if (event.type === 'human_correction') return `- ${label}：${(event.words ?? []).map((w) => `「${w}」`).join('')}`
  if (event.type === 'guard_denied') return `- ${label}：${event.rule ?? '?'} — ${event.target ?? ''}`
  if (event.type === 'verify_failed') {
    const incidents = event.incidents?.length ? `、関連する失敗票 ${event.incidents.join('、')}` : ''
    return `- ${label}：${event.name}（連続 ${event.streak} 回目${event.gave_up ? '、打ち切り' : ''}${incidents}）`
  }
  return `- ${label}`
}

const block = (text) => (text && String(text).trim() ? String(text).trim() : '（取得できませんでした）')

// 同じターンで何度呼ばれても、同じファイルを書き直す（ターンの途中の Stop でも、最後の状態が残る）。
export function writeEpisode(ctx, { sessionId, promptId, turnKey, startedAt, prompt, previous, signals, lastMessage, transcriptPath }) {
  const id = episodeId(sessionId, turnKey, startedAt)
  const kinds = [...new Set(signals.map((s) => s.type))]
  const lines = [
    '---',
    `id: ${id}`,
    `session_id: ${sessionId}`,
    `prompt_id: ${promptId ?? 'null'}`,
    `at: ${startedAt ?? iso()}`,
    `updated_at: ${iso()}`,
    `signals: [${kinds.join(', ')}]`,
    `transcript: ${transcriptPath ?? 'null'}`,
    '---',
    '',
    `# 事象メモ ${id}`,
    '',
    '## 依頼文',
    '',
    block(prompt),
    '',
    '## 起きたこと',
    '',
    ...signals.map(describe),
    '',
  ]
  // 訂正は次のターンの依頼文に現れる。訂正されたのは直前のターンなので、その依頼文と応答も並べる。
  if (kinds.includes('human_correction') && previous) {
    lines.push('## 直前のターン（訂正の対象）', '', '### 依頼文', '', block(previous.prompt), '', '### Claude の応答', '', block(previous.last_message), '')
  }
  lines.push('## Claude の最後の応答', '', block(lastMessage), '')
  mkdirSync(ctx.dirs.episodes, { recursive: true })
  writeFileAtomic(join(ctx.dirs.episodes, `${id}.md`), lines.join('\n'))
  return id
}

// 保持期間（初期値 90 日）を過ぎた事象メモと生ログを消す。dirs は、そのリポジトリのデータの置き場所。
export function pruneRecords(dirs, days) {
  if (!days) return 0
  const cutoff = now().getTime() - days * DAY_MS
  let removed = 0
  for (const [dir, ext] of [[dirs.episodes, '.md'], [dirs.events, '.jsonl']]) {
    for (const file of listFiles(dir, (f) => f.endsWith(ext))) {
      const path = join(dir, file)
      try {
        if (statSync(path).mtimeMs < cutoff) {
          rmSync(path, { force: true })
          removed++
        }
      } catch {
        // 消えていれば何もしない
      }
    }
  }
  return removed
}
