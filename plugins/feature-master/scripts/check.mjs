// 機能マスタ（docs/features/）のチェックと、一覧（README.md）の生成。Node の標準機能だけで動く。
//
//   node check.mjs [--json] [--repo <path>]
//
// 調べること:
//   - 機能ファイル（docs/features/<id>.md）の frontmatter と見出しが決まった形か
//   - actors と related が、actors.md の Actor と、ほかの機能ファイルを指しているか
//   - README.md の一覧が、機能ファイルから作ったものと同じか（古くても失敗にはしない）
// エラーがあれば終了コード 1。
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const FEATURES_DIR = 'docs/features'
export const INDEX = 'README.md'
export const ACTORS = 'actors.md'
export const STATUSES = ['提供中', '開発中', '廃止予定']
export const SECTIONS = ['概要', '利用シーン', '大事にしていること', '前提', '想定していないこと']
export const REQUIRED_SECTIONS = ['概要', '利用シーン']

const KEYS = ['id', 'name', 'status', 'draft', 'actors', 'related']
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const KEY = /^([A-Za-z_][\w-]*):(.*)$/

function scalar(raw) {
  const v = raw.trim()
  const quoted = /^(["'])(.*)\1$/.exec(v)
  if (quoted) return quoted[2]
  if (v === 'true') return true
  if (v === 'false') return false
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map(scalar)
      .filter((s) => s !== '')
  }
  return v
}

// 機能ファイルで使う形だけを読む: `key: 値`、`key: [a, b]`、`key:` に続く `- 値` か `- id: …` と `note: …` の組。
export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') return { error: { line: 1, message: '先頭に frontmatter（--- で囲んだ部分）がありません' } }
  const end = lines.indexOf('---', 1)
  if (end < 0) return { error: { line: 1, message: 'frontmatter の終わりの --- がありません' } }
  const data = {}
  const lineOf = {}
  let list = null
  let item = null
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    const n = i + 1
    if (!line.trim() || line.trim().startsWith('#')) continue
    let m = KEY.exec(line)
    if (m) {
      lineOf[m[1]] = n
      item = null
      list = m[2].trim() === '' ? [] : null
      data[m[1]] = list ?? scalar(m[2])
      continue
    }
    if (list && (m = /^\s+-\s*(.*)$/.exec(line))) {
      const kv = KEY.exec(m[1])
      item = kv ? { [kv[1]]: scalar(kv[2]) } : null
      if (item) Object.defineProperty(item, 'line', { value: n })
      list.push(item ?? scalar(m[1]))
      continue
    }
    if (item && (m = KEY.exec(line.trim())) && /^\s/.test(line)) {
      item[m[1]] = scalar(m[2])
      continue
    }
    return { error: { line: n, message: `frontmatter のこの行を読めません: ${line.trim()}` } }
  }
  return { data, lineOf, body: lines.slice(end + 1), bodyStart: end + 2 }
}

// `## 見出し` ごとに分ける。コードブロックの中は見ない。
export function parseSections(body, startLine = 1) {
  const sections = []
  let current = null
  let fence = false
  body.forEach((line, i) => {
    if (/^(```|~~~)/.test(line.trim())) fence = !fence
    const m = !fence && /^##\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) sections.push((current = { title: m[1], line: startLine + i, lines: [] }))
    else if (current) current.lines.push({ text: line, line: startLine + i })
  })
  return sections
}

function content(section) {
  return section.lines
    .map((l) => l.text)
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
}

// actors.md の `| ID | 名前 | 説明 |` の表を読む。
export function parseActors(text) {
  const actors = []
  let inTable = false
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim()
    if (!t.startsWith('|')) return void (inTable = false)
    const cells = t
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim())
    if (cells[0] === 'ID') return void (inTable = true)
    if (!inTable || cells.every((c) => /^:?-+:?$/.test(c))) return
    actors.push({ id: cells[0].replace(/^`|`$/g, ''), name: cells[1] ?? '', description: cells[2] ?? '', line: i + 1 })
  })
  return actors
}

function readFeature(repo, name) {
  const file = `${FEATURES_DIR}/${name}`
  const slug = name.replace(/\.md$/, '')
  const fm = parseFrontmatter(readFileSync(join(repo, file), 'utf8'))
  if (fm.error) return { file, slug, error: fm.error }
  return { file, slug, data: fm.data, lineOf: fm.lineOf, sections: parseSections(fm.body, fm.bodyStart) }
}

export function loadFeatures(repo) {
  return readdirSync(join(repo, FEATURES_DIR))
    .filter((n) => n.endsWith('.md') && n !== INDEX && n !== ACTORS)
    .sort()
    .map((n) => readFeature(repo, n))
}

export function loadActors(repo) {
  const file = join(repo, FEATURES_DIR, ACTORS)
  return existsSync(file) ? parseActors(readFileSync(file, 'utf8')) : null
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')

function summary(feature) {
  const s = feature.sections?.find((x) => x.title === '概要')
  return s ? content(s).split('\n')[0] : ''
}

export function renderIndex(features, actors) {
  const names = new Map(actors.map((a) => [a.id, a.name || a.id]))
  const uses = (id) => features.filter((f) => f.data.actors?.includes(id)).length
  const out = [
    '# 機能マスタ',
    '',
    '<!-- feature-master が機能ファイルから作る一覧。手で直さない（/feature-master:check で古くなっていないか確かめ、作り直す） -->',
    '',
    'このプロダクトの機能と、それぞれがどんな利用シーンを想定して作られているか。機能を付け足すときや新しい機能を考えるときは、関係する機能のファイルの「利用シーン」「大事にしていること」「前提」「想定していないこと」を先に読む。',
    '',
    '## Actor',
    '',
    '| ID | 名前 | 説明 | 機能の数 |',
    '| :- | :- | :- | -: |',
    ...actors.map((a) => `| ${cell(a.id)} | ${cell(a.name)} | ${cell(a.description)} | ${uses(a.id)} |`),
    '',
    '## 機能',
    '',
    '| 機能 | 状態 | Actor | 概要 | 関連機能 |',
    '| :- | :- | :- | :- | :- |',
  ]
  for (const f of features) {
    const status = f.data.status + (f.data.draft === true ? '（下書き）' : '')
    const who = (f.data.actors ?? []).map((a) => names.get(a) ?? a).join('、')
    const related = (f.data.related ?? []).map((r) => `[${r.id}](${r.id}.md)`).join(', ')
    out.push(`| [${cell(f.data.name)}](${f.slug}.md) | ${cell(status)} | ${cell(who)} | ${cell(summary(f))} | ${related} |`)
  }
  return out.join('\n') + '\n'
}

export function runCheck(repo) {
  if (!existsSync(join(repo, FEATURES_DIR))) throw new Error(`${FEATURES_DIR}/ がありません（/feature-master:init で作る）`)
  const errors = []
  const warnings = []
  const stale = []
  const drafts = []
  const err = (file, line, rule, message) => errors.push({ file, line, rule, message })
  const warn = (file, line, rule, message) => warnings.push({ file, line, rule, message })

  const actorsFile = `${FEATURES_DIR}/${ACTORS}`
  const actors = loadActors(repo) ?? []
  if (!existsSync(join(repo, actorsFile))) err(actorsFile, 1, 'actors', 'actors.md がありません')
  else if (!actors.length) err(actorsFile, 1, 'actors', 'Actor の表（| ID | 名前 | 説明 |）に行がありません')
  const actorIds = new Set()
  for (const a of actors) {
    if (!ID.test(a.id)) err(actorsFile, a.line, 'actors', `Actor の ID「${a.id}」は小文字の kebab-case にする`)
    if (actorIds.has(a.id)) err(actorsFile, a.line, 'actors', `Actor の ID「${a.id}」が重複しています`)
    if (!a.name) err(actorsFile, a.line, 'actors', `Actor「${a.id}」の名前がありません`)
    actorIds.add(a.id)
  }

  const features = loadFeatures(repo)
  const slugs = new Set(features.map((f) => f.slug))
  for (const f of features) {
    if (f.error) {
      err(f.file, f.error.line, 'frontmatter', f.error.message)
      continue
    }
    const { data, lineOf, file } = f
    const at = (key) => lineOf[key] ?? 1
    for (const key of Object.keys(data)) if (!KEYS.includes(key)) warn(file, at(key), 'key', `知らない項目「${key}」（使えるのは ${KEYS.join('・')}）`)

    if (!ID.test(f.slug)) err(file, 1, 'id', 'ファイル名は小文字の kebab-case の id にする（例: task-create.md）')
    if (!data.id) err(file, 1, 'id', 'id がありません')
    else if (data.id !== f.slug) err(file, at('id'), 'id', `id「${data.id}」がファイル名「${f.slug}」と違います`)
    if (typeof data.name !== 'string' || !data.name) err(file, at('name'), 'name', 'name（機能名）がありません')
    if (!STATUSES.includes(data.status)) err(file, at('status'), 'status', `status は ${STATUSES.join('・')} のどれかにする`)
    if ('draft' in data && typeof data.draft !== 'boolean') err(file, at('draft'), 'draft', 'draft は true か false にする')
    if (data.draft === true) drafts.push({ id: f.slug, file })

    if (!Array.isArray(data.actors) || !data.actors.length) err(file, at('actors'), 'actors', 'actors（使う Actor の ID）がありません')
    else for (const a of data.actors) if (!actorIds.has(a)) err(file, at('actors'), 'actors', `Actor「${a}」が actors.md にありません`)

    if ('related' in data && !Array.isArray(data.related)) err(file, at('related'), 'related', 'related は `- id: …` と `note: …` の組のリストにする')
    const seen = new Set()
    for (const r of Array.isArray(data.related) ? data.related : []) {
      const line = r?.line ?? at('related')
      if (!r || typeof r !== 'object' || !r.id) {
        err(file, line, 'related', 'related の要素は `- id: …` と `note: …` の組にする')
        continue
      }
      if (r.id === f.slug) err(file, line, 'related', 'related に自分自身を入れない')
      else if (!slugs.has(r.id)) err(file, line, 'related', `関連機能「${r.id}」の機能ファイルがありません`)
      if (seen.has(r.id)) warn(file, line, 'related', `関連機能「${r.id}」が重複しています`)
      seen.add(r.id)
      if (typeof r.note !== 'string' || !r.note) warn(file, line, 'related', `関連機能「${r.id}」の note（利用シーン上のつながり）がありません`)
    }

    const titles = new Set()
    for (const s of f.sections) {
      if (!SECTIONS.includes(s.title)) warn(file, s.line, 'section', `知らない見出し「${s.title}」（使えるのは ${SECTIONS.join('・')}）`)
      if (titles.has(s.title)) warn(file, s.line, 'section', `見出し「${s.title}」が重複しています`)
      titles.add(s.title)
    }
    for (const title of REQUIRED_SECTIONS) {
      const s = f.sections.find((x) => x.title === title)
      if (!s) err(file, 1, 'section', `「## ${title}」がありません`)
      else if (!content(s)) err(file, s.line, 'section', `「## ${title}」が空です`)
    }
    const scenes = f.sections.find((x) => x.title === '利用シーン')
    if (scenes && content(scenes)) {
      const items = scenes.lines.filter((l) => /^\s*[-*]\s+/.test(l.text))
      if (!items.length) warn(file, scenes.line, 'scene', '利用シーンは「- 状況 → したいこと」の箇条書きにする')
      for (const l of items) if (!l.text.includes('→')) warn(file, l.line, 'scene', '利用シーンは「状況 → したいこと」の形にする')
    }
  }

  for (const a of actors) {
    if (!features.some((f) => Array.isArray(f.data?.actors) && f.data.actors.includes(a.id))) warn(actorsFile, a.line, 'actors', `Actor「${a.id}」を使っている機能がありません`)
  }

  // 一覧はエラーのない機能ファイルからしか作れないので、エラーがあるあいだは比べない
  if (!errors.length) {
    const indexFile = join(repo, FEATURES_DIR, INDEX)
    const current = existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : null
    if (current !== renderIndex(features, actors)) stale.push(`${FEATURES_DIR}/${INDEX} の一覧が機能ファイルと合っていません（作り直す）`)
  }
  return { ok: errors.length === 0, errors, warnings, stale, drafts, features: features.length, actors: actors.length }
}

export function formatResult(r) {
  const out = [r.ok ? `機能マスタのチェック: エラーなし（機能 ${r.features}・Actor ${r.actors}）` : `機能マスタのチェック: エラー ${r.errors.length} 件（機能 ${r.features}・Actor ${r.actors}）`]
  for (const e of r.errors) out.push(`${e.file}:${e.line} ${e.rule} → ${e.message}`)
  if (r.warnings.length) out.push('警告:', ...r.warnings.map((w) => `${w.file}:${w.line} ${w.rule} → ${w.message}`))
  if (r.drafts.length) out.push(`下書き（draft: true）: ${r.drafts.map((d) => d.id).join(', ')}`)
  if (r.stale.length) out.push('古くなったもの:', ...r.stale.map((s) => `- ${s}`))
  return out.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--repo')
  const repo = at >= 0 ? resolve(args[at + 1]) : process.cwd()
  try {
    const r = runCheck(repo)
    console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : formatResult(r))
    process.exitCode = r.ok ? 0 : 1
  } catch (e) {
    console.error(e.message)
    process.exitCode = 2
  }
}
