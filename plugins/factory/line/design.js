// アプリのデザインシステム（design-system プラグインが作る design-system/design-system.json）を読む。
// デザインシステムは人が決めるもので、factory は使うだけ。ファイルは実装役が変えられないよう禁止ファイルに足す。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DESIGN_SYSTEM_FILE = join('design-system', 'design-system.json')

export function loadDesignSystem(repo) {
  const file = join(repo, DESIGN_SYSTEM_FILE)
  if (!existsSync(file)) return null
  const ds = JSON.parse(readFileSync(file, 'utf8'))
  const docs = Array.isArray(ds.docs) ? ds.docs : []
  return {
    docs,
    // インタビューとシナリオ作成で、期待する文言と画面の形を合わせるための文書
    copyDocs: docs.filter((d) => /(copy|patterns)\.md$/.test(d)),
    protected_paths: Array.isArray(ds.protected_paths) ? ds.protected_paths : [],
    check: ds.check?.command ?? null,
  }
}

// 実装役の報告の「## 部品の候補」の箇条書きを取り出す（デザインシステムにない部品を組んだときに書かせる）。
export function parseComponentCandidates(text) {
  const section = /^##\s*部品の候補\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(text)?.[1] ?? ''
  return section
    .split('\n')
    .map((l) => /^\s*[-*]\s+(.+?)\s*$/.exec(l)?.[1])
    .filter(Boolean)
}
