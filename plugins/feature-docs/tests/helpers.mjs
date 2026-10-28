import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export function makeRepo(files = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'feature-docs-'))
  writeFiles(repo, files)
  return repo
}

export function writeFiles(repo, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repo, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

export const ACTORS = `actors:
  - id: A-member
    name: 会員
    kind: human
    description: 投稿を読む人
`

const SECTIONS = ['背景と課題', '目的とKPI', '誰が・いつ', '利用者の流れ', 'スコープ / 非ゴール', '受け入れ条件', '画面と状態']

export function req({ id = 'REQ-0001', status = 'approved', newF = ['F-001'], changed = [], ui = null, actors = ['A-member'], extra = '', sections = SECTIONS } = {}) {
  return `---
id: ${id}
title: お気に入り
status: ${status}
features:
  new: [${newF.join(', ')}]
  changed: [${changed.join(', ')}]
actors: [${actors.join(', ')}]
${ui ? `ui: ${ui}\n` : ''}${extra}---

# お気に入り

${sections.map((s) => `## ${s}\n\n本文\n`).join('\n')}`
}

export function design({ feature = 'F-001', pending = [], extra = '' } = {}) {
  return `---
feature: ${feature}
pending: [${pending.join(', ')}]
${extra}---

# ${feature} 設計

## 要件（EARS）

- When 会員がタップしたとき, the app shall 表示を切り替える

\`\`\`markdown
## これは見出しではない
\`\`\`

## 受け入れ条件

- Given … When … Then …
`
}

export function feature({ id = 'F-001', status = 'ga', requirements = ['REQ-0001'], extra = '', help = true } = {}) {
  return `id: ${id}
name: お気に入り
status: ${status}
platforms: [ios, android]
since_version: "1.0.0"
requirements: [${requirements.join(', ')}]
actors:
  primary: A-member
jobs:
  - あとで読み返したいとき、すぐに保存したい
scenes:
  - when: 通勤中
    situation: 片手操作
user_flows:
  - goal: 投稿を保存する
    trigger: ハートをタップ
    steps:
      - ハートをタップする
    when_things_differ:
      - condition: 圏外のとき
        user_sees: あとで反映される
    result: 一覧に出る
limits:
  - 500件まで
${help ? `help:
  summary: 投稿をハートで保存できます
  how_to:
    - ハートをタップします
  limitations:
    - フォルダ分けはできません
  faq:
    - q: オフラインでも保存できますか？
      a: できます
  synonyms: [ブックマーク]
  visibility: public
  escalation: アプリ内のお問い合わせ
changelog:
  - version: "1.0.0"
    date: 2026-10-01
    change: お気に入りを追加しました
last_reviewed: 2026-10-28
` : ''}${extra}`
}
