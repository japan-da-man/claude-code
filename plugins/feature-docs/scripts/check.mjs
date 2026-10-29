#!/usr/bin/env node
// feature-docs のチェッカー。アプリのリポジトリの feature-docs/check.mjs に写して使う（プラグインがなくても CI で動く）。
// 依存なし（Node 20 以上）。YAML は下の小さな読み込みで読む（手元と CI で結果が変わらないように、yaml パッケージは使わない）。
//
//   node feature-docs/check.mjs [repo] [--json]                    要件定義書・設計書・機能マスタの整合を調べる（誤りがあれば終了コード 1）
//   node feature-docs/check.mjs status [repo]                      要件定義書ごとの段階と、次にやることを JSON で出す
//   node feature-docs/check.mjs next-id req|feature [repo]         次の REQ / F の番号を出す
//   node feature-docs/check.mjs export-help [repo] [--out <dir>] [--force]
//                                                                  機能マスタから、ヘルプ AI 用のナレッジ（Markdown と index.json）を書き出す
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CONFIG_PATH = 'feature-docs/config.json'

export const DEFAULT_CONFIG = {
  version: 1,
  paths: {
    product: 'docs/product/overview.md',
    requirements: 'docs/requirements',
    design: 'docs/design',
    ui: 'docs/ui',
    architecture: 'docs/architecture',
    adr: 'docs/adr',
    tracking: 'tracking',
    features: 'features',
    actors: 'actors.yaml',
    glossary: 'glossary.yaml',
    help_out: 'docs/generated/help',
  },
  requirements: {
    required_sections: ['背景と課題', '目的とKPI', '誰が・いつ', '利用者の流れ', 'スコープ / 非ゴール', '受け入れ条件', '画面と状態'],
  },
  design: {
    required_sections: ['要件（EARS）', '受け入れ条件'],
  },
  integration_branch_prefix: 'feature/',
}

export const REQ_STATUSES = ['draft', 'approved', 'designed', 'implemented', 'rejected', 'withdrawn']
export const FEATURE_STATUSES = ['beta', 'ga', 'deprecated']
// 機能マスタに置いてはいけない、システムの振る舞いや裏側の項目（設計書・トラッキングプランに置く）
export const INTERNAL_KEYS = [
  'api', 'endpoints', 'data', 'schema', 'db', 'feature_flag', 'flags', 'events', 'tracking', 'sequence', 'states',
  'screens', 'nfr', 'security', 'rollout', 'acceptance', 'non_goals', 'pending',
]

const REQ_ID = /^REQ-\d{4,}$/
const F_ID = /^F-\d{3,}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

// ---------------------------------------------------------------- YAML

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `${line} 行目: ${message}` : message)
    this.line = line
  }
}

function stripComment(text) {
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === "'" && quote === "'" && text[i + 1] === "'") i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s\[,:-]/.test(text[i - 1])) quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i)
    }
  }
  return text
}

function splitFlow(inner, line) {
  const parts = []
  let depth = 0
  let quote = null
  let cur = ''
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"') cur += inner[++i] ?? ''
      else if (c === "'" && quote === "'" && inner[i + 1] === "'") cur += inner[++i]
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '[') depth++
    else if (c === ']') depth--
    else if (c === '{') throw new YamlError('{ } の書き方（フローのマップ）には対応していません', line)
    if (c === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += c
  }
  if (quote || depth !== 0) throw new YamlError('[ ] か引用符が閉じていません', line)
  if (cur.trim() !== '' || parts.length) parts.push(cur)
  return parts.map((p) => p.trim())
}

function parseScalar(raw, line) {
  const s = raw.trim()
  if (s === '' || s === '~' || /^(null|Null|NULL)$/.test(s)) return null
  if (s[0] === '&' || s[0] === '*' || s[0] === '!') throw new YamlError('アンカー・エイリアス・タグには対応していません', line)
  if (s[0] === '"') {
    if (s.length < 2 || s[s.length - 1] !== '"') throw new YamlError('" が閉じていません', line)
    try {
      return JSON.parse(s)
    } catch {
      throw new YamlError(`読めない文字列です: ${s}`, line)
    }
  }
  if (s[0] === "'") {
    if (s.length < 2 || s[s.length - 1] !== "'") throw new YamlError("' が閉じていません", line)
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (s[0] === '[') {
    if (s[s.length - 1] !== ']') throw new YamlError('[ が閉じていません', line)
    const inner = s.slice(1, -1)
    if (inner.trim() === '') return []
    return splitFlow(inner, line).map((p) => parseScalar(p, line))
  }
  if (s === '{}') return {}
  if (s[0] === '{') throw new YamlError('{ } の書き方（フローのマップ）には対応していません', line)
  if (/^(true|True|TRUE)$/.test(s)) return true
  if (/^(false|False|FALSE)$/.test(s)) return false
  if (/^-?\d+(\.\d+)?$/.test(s) && !/^-?0\d/.test(s)) return Number(s)
  // 「注意: 上限あり」のような値は、YAML ではマップの入れ子になって読めない。ほかの YAML の読み込みと結果を変えないために弾く
  if (/:(\s|$)/.test(s)) throw new YamlError(`値に「: 」があります。値を引用符で囲んでください: ${s}`, line)
  return s
}

const KEY_LINE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#\[\]{},:][^:#]*?)\s*:(?:\s+(.*)|\s*)$/

function parseKey(k, line) {
  if (k[0] === '"' || k[0] === "'") return parseScalar(k, line)
  return k.trim()
}

// 機能マスタなどで使う範囲の YAML（マップ、リスト、[a, b]、引用符、| と > のブロック）を読む。
export function parseYamlSubset(text) {
  const raw = text.replace(/\r\n?/g, '\n').split('\n')
  const lines = []
  raw.forEach((r, i) => {
    if (/^\s*\t/.test(r) || /^ *\t/.test(r)) throw new YamlError('インデントにタブは使えません', i + 1)
    const stripped = stripComment(r).replace(/\s+$/, '')
    if (stripped.trim() === '' || stripped.trim() === '---' || stripped.trim() === '...') return
    const indent = stripped.length - stripped.trimStart().length
    lines.push({ indent, text: stripped.trimStart(), no: i + 1, raw: i })
  })
  let pos = 0

  const isSeq = (l) => l.text === '-' || l.text.startsWith('- ')

  function blockScalar(header, keyIndent, keyLine) {
    const style = header[0]
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip'
    const body = []
    let r = keyLine.raw + 1
    let indent = null
    for (; r < raw.length; r++) {
      const t = raw[r].replace(/\s+$/, '')
      if (t.trim() === '') {
        body.push('')
        continue
      }
      const ind = t.length - t.trimStart().length
      if (ind <= keyIndent) break
      if (indent === null) indent = ind
      if (ind < indent) throw new YamlError('ブロックの中のインデントがそろっていません', r + 1)
      body.push(t.slice(indent))
    }
    while (pos < lines.length && lines[pos].raw < r) pos++
    let trailing = 0
    while (body.length && body[body.length - 1] === '') {
      body.pop()
      trailing++
    }
    let out
    if (style === '|') out = body.join('\n')
    else {
      out = ''
      for (const b of body) {
        if (b === '') out += '\n'
        else out += out === '' || out.endsWith('\n') ? b : ' ' + b
      }
    }
    if (body.length === 0) return ''
    if (chomp === 'clip') return out + '\n'
    if (chomp === 'keep') return out + '\n'.repeat(trailing + 1)
    return out
  }

  function parseNode(indent) {
    if (pos >= lines.length) return null
    const l = lines[pos]
    if (l.indent < indent) return null
    return isSeq(l) ? parseSeq(l.indent) : parseMap(l.indent)
  }

  function parseSeq(indent) {
    const out = []
    while (pos < lines.length && lines[pos].indent === indent && isSeq(lines[pos])) {
      const l = lines[pos]
      const content = l.text === '-' ? '' : l.text.slice(2)
      const offset = l.text === '-' ? 1 : 2 + (content.length - content.trimStart().length)
      const c = content.trimStart()
      if (c === '') {
        pos++
        if (pos < lines.length && lines[pos].indent > indent) out.push(parseNode(lines[pos].indent))
        else out.push(null)
      } else if (/^[|>][+-]?$/.test(c)) {
        // 「- |」の項目は、続く行をブロックとして読む
        out.push(blockScalar(c, indent, l))
      } else if (isSeq({ text: c }) || KEY_LINE.test(c)) {
        // 「- key: value」や「- - a」は、項目の中身を 1 段深い行として読み直す
        lines[pos] = { ...l, indent: indent + offset, text: c }
        out.push(parseNode(indent + offset))
      } else {
        pos++
        if (pos < lines.length && lines[pos].indent > indent) throw new YamlError('リストの項目の続きの行には対応していません（引用符か | を使ってください）', lines[pos].no)
        out.push(parseScalar(c, l.no))
      }
    }
    return out
  }

  function parseMap(indent) {
    const out = {}
    while (pos < lines.length && lines[pos].indent === indent) {
      const l = lines[pos]
      if (isSeq(l)) throw new YamlError('マップの中にリストの項目があります（インデントを確かめてください）', l.no)
      const m = l.text.match(KEY_LINE)
      if (!m) throw new YamlError(`「キー: 値」の形になっていません: ${l.text}`, l.no)
      const key = String(parseKey(m[1], l.no))
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(`キー「${key}」が重複しています`, l.no)
      const rest = (m[2] ?? '').trim()
      pos++
      if (/^[|>][+-]?$/.test(rest)) {
        out[key] = blockScalar(rest, indent, l)
      } else if (rest === '') {
        if (pos < lines.length && lines[pos].indent > indent) out[key] = parseNode(lines[pos].indent)
        else if (pos < lines.length && lines[pos].indent === indent && isSeq(lines[pos])) out[key] = parseSeq(indent)
        else out[key] = null
      } else {
        out[key] = parseScalar(rest, l.no)
        if (pos < lines.length && lines[pos].indent > indent) throw new YamlError('値の続きの行には対応していません（引用符か | を使ってください）', lines[pos].no)
      }
    }
    if (pos < lines.length && lines[pos].indent > indent) throw new YamlError('インデントがずれています', lines[pos].no)
    return out
  }

  if (lines.length === 0) return null
  const result = parseNode(lines[0].indent)
  if (pos < lines.length) throw new YamlError('インデントがずれています', lines[pos].no)
  return result
}

// 先頭の BOM（Windows のエディタが付ける）は読み飛ばす
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

export function parseYaml(text) {
  return parseYamlSubset(stripBom(text))
}

// Markdown の先頭の --- で囲んだ部分（フロントマター）と、## の見出しを読む
export function parseMarkdown(text) {
  const t = stripBom(text).replace(/\r\n?/g, '\n')
  let data = {}
  let body = t
  if (t.startsWith('---\n')) {
    const end = t.indexOf('\n---', 4)
    if (end === -1) throw new YamlError('フロントマターの終わりの --- がありません', 1)
    const fm = t.slice(4, end)
    try {
      data = parseYaml(fm) ?? {}
    } catch (e) {
      throw new YamlError(`フロントマター: ${e.message}`)
    }
    body = t.slice(t.indexOf('\n', end + 1) + 1)
  }
  const headings = []
  let fence = null
  for (const line of body.split('\n')) {
    const f = line.match(/^\s*(```|~~~)/)
    if (f) {
      if (!fence) fence = f[1]
      else if (fence === f[1]) fence = null
      continue
    }
    if (fence) continue
    const h = line.match(/^##\s+(.+?)\s*#*\s*$/)
    if (h) headings.push(h[1].trim())
  }
  return { data, body, headings }
}

// ---------------------------------------------------------------- 読み込み

export function loadConfig(repo) {
  const file = join(repo, CONFIG_PATH)
  if (!existsSync(file)) return structuredClone(DEFAULT_CONFIG)
  const user = JSON.parse(readFileSync(file, 'utf8'))
  return {
    ...DEFAULT_CONFIG,
    ...user,
    paths: { ...DEFAULT_CONFIG.paths, ...(user.paths ?? {}) },
    requirements: { ...DEFAULT_CONFIG.requirements, ...(user.requirements ?? {}) },
    design: { ...DEFAULT_CONFIG.design, ...(user.design ?? {}) },
  }
}

function listFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()).sort()
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v])
const isText = (v) => typeof v === 'string' && v.trim() !== ''
const isList = (v) => Array.isArray(v) && v.length > 0

export function loadAll(repo) {
  const config = loadConfig(repo)
  const p = config.paths
  const findings = []
  const add = (level, file, rule, message) => findings.push({ level, file, rule, message })

  const readYamlFile = (rel) => {
    try {
      return parseYaml(readFileSync(join(repo, rel), 'utf8'))
    } catch (e) {
      add('error', rel, 'parse', e.message)
      return undefined
    }
  }
  const readMdFile = (rel) => {
    try {
      return parseMarkdown(readFileSync(join(repo, rel), 'utf8'))
    } catch (e) {
      add('error', rel, 'parse', e.message)
      return undefined
    }
  }
  const ignored = (f) => f.startsWith('_') || f.startsWith('.') || /^readme\.md$/i.test(f)

  const features = []
  for (const f of listFiles(join(repo, p.features))) {
    if (ignored(f) || !/\.ya?ml$/.test(f)) continue
    const rel = `${p.features}/${f}`
    const m = f.match(/^(F-\d{3,})(-[a-z0-9-]+)?\.ya?ml$/)
    if (!m) {
      add('error', rel, 'filename', 'ファイル名は F-<3桁以上の番号>-<英小文字の名前>.yaml にしてください')
      continue
    }
    const data = readYamlFile(rel)
    if (data === undefined) continue
    features.push({ file: rel, fileId: m[1], data: data ?? {} })
  }

  const requirements = []
  for (const f of listFiles(join(repo, p.requirements))) {
    if (ignored(f) || !f.endsWith('.md')) continue
    const rel = `${p.requirements}/${f}`
    const m = f.match(/^(REQ-\d{4,})(-[a-z0-9-]+)?\.md$/)
    if (!m) {
      add('error', rel, 'filename', 'ファイル名は REQ-<4桁以上の番号>-<英小文字の名前>.md にしてください')
      continue
    }
    const doc = readMdFile(rel)
    if (!doc) continue
    requirements.push({ file: rel, fileId: m[1], ...doc })
  }

  const designs = []
  for (const f of listFiles(join(repo, p.design))) {
    if (ignored(f) || !f.endsWith('.md')) continue
    const rel = `${p.design}/${f}`
    const m = f.match(/^(F-\d{3,})(-[a-z0-9-]+)?\.md$/)
    if (!m) {
      add('error', rel, 'filename', 'ファイル名は F-<番号>-<英小文字の名前>.md にしてください（機能 ID と同じ番号）')
      continue
    }
    const doc = readMdFile(rel)
    if (!doc) continue
    designs.push({ file: rel, fileId: m[1], ...doc })
  }

  let actors = null
  if (existsSync(join(repo, p.actors))) {
    const data = readYamlFile(p.actors)
    if (data !== undefined) actors = asArray(data?.actors)
  }
  let glossary = null
  if (existsSync(join(repo, p.glossary))) {
    const data = readYamlFile(p.glossary)
    if (data !== undefined) glossary = asArray(data?.terms)
  }

  return { config, features, requirements, designs, actors, glossary, findings }
}

// ---------------------------------------------------------------- チェック

export function runCheck(repo) {
  const all = loadAll(repo)
  const { config, features, requirements, designs, actors, glossary } = all
  const findings = [...all.findings]
  const add = (level, file, rule, message) => findings.push({ level, file, rule, message })
  const p = config.paths

  // 共通マスタ
  const actorIds = new Set()
  if (actors) {
    actors.forEach((a, i) => {
      const where = `actors[${i}]`
      if (!a || typeof a !== 'object') return add('error', p.actors, 'actors', `${where} がマップになっていません`)
      if (!isText(a.id)) return add('error', p.actors, 'actors', `${where} に id がありません`)
      if (actorIds.has(a.id)) add('error', p.actors, 'actors', `アクター ${a.id} が重複しています`)
      actorIds.add(a.id)
      if (!isText(a.name)) add('error', p.actors, 'actors', `${a.id} に name がありません`)
      if (!['human', 'system'].includes(a.kind)) add('error', p.actors, 'actors', `${a.id} の kind は human か system にしてください`)
    })
  }
  if (glossary) {
    const terms = new Set()
    glossary.forEach((t, i) => {
      if (!t || !isText(t.term)) return add('error', p.glossary, 'glossary', `terms[${i}] に term がありません`)
      if (terms.has(t.term)) add('error', p.glossary, 'glossary', `用語「${t.term}」が重複しています`)
      terms.add(t.term)
      if (!isText(t.description)) add('warning', p.glossary, 'glossary', `用語「${t.term}」に description がありません`)
    })
  }
  const checkActor = (file, id, label) => {
    if (!isText(id)) return add('error', file, 'actors', `${label} がありません`)
    if (!actors) return add('error', file, 'actors', `${p.actors} がないので ${id} を確かめられません`)
    if (!actorIds.has(id)) add('error', file, 'actors', `${label} の ${id} が ${p.actors} にありません`)
  }

  // ID の表
  const featureById = new Map()
  for (const f of features) {
    const id = f.data.id
    if (id !== f.fileId) add('error', f.file, 'id', `id（${id ?? 'なし'}）がファイル名の ${f.fileId} と合っていません`)
    if (featureById.has(f.fileId)) add('error', f.file, 'id', `機能 ID ${f.fileId} が重複しています`)
    featureById.set(f.fileId, f)
  }
  const reqById = new Map()
  for (const r of requirements) {
    const id = r.data.id
    if (id !== r.fileId) add('error', r.file, 'id', `id（${id ?? 'なし'}）がファイル名の ${r.fileId} と合っていません`)
    if (reqById.has(r.fileId)) add('error', r.file, 'id', `要件定義書 ID ${r.fileId} が重複しています`)
    reqById.set(r.fileId, r)
  }
  const designsById = new Map()
  for (const d of designs) {
    if (d.data.feature !== d.fileId) add('error', d.file, 'id', `feature（${d.data.feature ?? 'なし'}）がファイル名の ${d.fileId} と合っていません`)
    if (designsById.has(d.fileId)) add('error', d.file, 'id', `機能 ${d.fileId} の設計書が 2 つあります`)
    designsById.set(d.fileId, d)
  }
  const reqFeatures = (r) => ({
    new: asArray(r.data.features?.new).map(String),
    changed: asArray(r.data.features?.changed).map(String),
  })
  // 新規の機能として要件定義書に載っていて、まだ機能マスタにない ID（設計と実装の途中）
  const plannedNew = new Map()
  for (const r of requirements) {
    if (['rejected', 'withdrawn'].includes(r.data.status)) continue
    for (const id of reqFeatures(r).new) if (!plannedNew.has(id)) plannedNew.set(id, r.fileId)
  }
  const sectionsMissing = (headings, required) =>
    required.filter((s) => !headings.some((h) => h.replace(/\s+/g, '') === s.replace(/\s+/g, '') || h.replace(/\s+/g, '').startsWith(s.replace(/\s+/g, ''))))

  // 要件定義書
  for (const r of requirements) {
    const d = r.data
    const status = d.status
    if (!REQ_STATUSES.includes(status)) {
      add('error', r.file, 'status', `status は ${REQ_STATUSES.join(' / ')} のどれかにしてください（今は ${status ?? 'なし'}）`)
      continue
    }
    if (!isText(d.title)) add('error', r.file, 'title', 'title がありません')
    for (const s of asArray(d.supersedes)) {
      if (!reqById.has(s)) add('error', r.file, 'supersedes', `supersedes の ${s} がありません`)
    }
    if (['rejected', 'withdrawn'].includes(status)) {
      if (!isText(d.reason)) add('error', r.file, 'reason', `${status} にした理由（reason）を書いてください`)
      continue
    }
    const fs = reqFeatures(r)
    for (const id of [...fs.new, ...fs.changed]) {
      if (!F_ID.test(id)) add('error', r.file, 'features', `機能 ID ${id} の形が違います（F-012 のように）`)
    }
    for (const id of fs.new) {
      if (plannedNew.get(id) !== r.fileId) add('error', r.file, 'features', `新規の機能 ${id} は ${plannedNew.get(id)} でも新規になっています`)
    }
    const newActors = asArray(d.new_actors)
    const newActorIds = new Set(newActors.map((a) => a?.id))
    newActors.forEach((a, i) => {
      if (!a || !isText(a.id) || !isText(a.name) || !['human', 'system'].includes(a.kind)) {
        add('error', r.file, 'new_actors', `new_actors[${i}] には id・name・kind（human / system）を書いてください`)
      }
    })
    if (status === 'draft') continue

    // approved 以降
    if (fs.new.length + fs.changed.length === 0) add('error', r.file, 'features', '影響する機能（features.new / features.changed）が 1 つもありません')
    for (const id of fs.changed) {
      if (!featureById.has(id)) add('error', r.file, 'features', `変更する機能 ${id} が ${p.features} にありません（新しい機能なら features.new に）`)
    }
    if (!isList(d.actors)) add('error', r.file, 'actors', 'actors（対象のアクター）を 1 つ以上書いてください')
    for (const id of asArray(d.actors)) {
      if (newActorIds.has(id) && status !== 'implemented') continue
      checkActor(r.file, id, 'actors')
    }
    const missing = sectionsMissing(r.headings, config.requirements.required_sections)
    if (missing.length) add('error', r.file, 'sections', `節がありません: ${missing.map((s) => `## ${s}`).join('、')}`)

    if (status === 'approved' || status === 'designed') {
      for (const id of fs.new) {
        if (featureById.has(id)) add('error', r.file, 'features', `新規の機能 ${id} がもう ${p.features} にあります（機能マスタは実装の最後の PR で足します）`)
      }
    }
    if (status === 'designed') {
      for (const id of [...fs.new, ...fs.changed]) {
        const des = designsById.get(id)
        if (!des) add('error', r.file, 'design', `機能 ${id} の設計書が ${p.design} にありません`)
        else if (!asArray(des.data.pending).includes(r.fileId)) add('error', des.file, 'pending', `pending に ${r.fileId} がありません（設計の PR で付けます）`)
      }
      if (d.ui !== 'none') {
        const dir = join(repo, p.ui, r.fileId)
        if (!existsSync(dir) || readdirSync(dir).filter((f) => !f.startsWith('.')).length === 0) {
          add('error', r.file, 'ui', `UI 案が ${p.ui}/${r.fileId}/ にありません（画面が変わらないなら、フロントマターに ui: none）`)
        }
      }
    }
    if (status === 'implemented') {
      for (const id of [...fs.new, ...fs.changed]) {
        const f = featureById.get(id)
        if (!f) add('error', r.file, 'features', `機能 ${id} が ${p.features} にありません（最後の PR で機能マスタに足します）`)
        else if (!asArray(f.data.requirements).includes(r.fileId)) add('error', f.file, 'requirements', `requirements に ${r.fileId} がありません`)
      }
      for (const a of newActors) {
        if (isText(a?.id) && !actorIds.has(a.id)) add('error', r.file, 'new_actors', `新しいアクター ${a.id} がまだ ${p.actors} にありません`)
      }
    }
  }

  // 設計書
  for (const des of designs) {
    const d = des.data
    const id = des.fileId
    if (!featureById.has(id) && !plannedNew.has(id)) {
      add('error', des.file, 'feature', `機能 ${id} が機能マスタにも、要件定義書の features.new にもありません`)
    }
    for (const dep of asArray(d.depends_on)) {
      if (!featureById.has(dep) && !plannedNew.has(dep)) add('error', des.file, 'depends_on', `depends_on の ${dep} がありません`)
    }
    for (const reqId of asArray(d.pending)) {
      const r = reqById.get(reqId)
      if (!r) add('error', des.file, 'pending', `pending の ${reqId} がありません`)
      else if (r.data.status !== 'designed') add('error', des.file, 'pending', `pending の ${reqId} が designed ではありません（今は ${r.data.status}。実装し終えたら pending から外します）`)
      else {
        const fs = reqFeatures(r)
        if (![...fs.new, ...fs.changed].includes(id)) add('error', des.file, 'pending', `${reqId} の features に ${id} がありません`)
      }
    }
    if (d.tracking != null && !existsSync(join(repo, String(d.tracking)))) add('error', des.file, 'tracking', `tracking の ${d.tracking} がありません`)
    for (const u of asArray(d.ui)) {
      const s = String(u)
      if (!/^https?:\/\//.test(s) && !existsSync(join(repo, s))) add('error', des.file, 'ui', `ui の ${s} がありません`)
    }
    const missing = sectionsMissing(des.headings, config.design.required_sections)
    if (missing.length) add('error', des.file, 'sections', `節がありません: ${missing.map((s) => `## ${s}`).join('、')}`)
  }

  // 機能マスタ
  for (const f of features) {
    const d = f.data
    const status = d.status
    if (status === 'planned') {
      add('error', f.file, 'status', '機能マスタには計画中（planned）の機能を載せません。要件定義書に書き、実装の最後の PR で足します')
      continue
    }
    if (!FEATURE_STATUSES.includes(status)) {
      add('error', f.file, 'status', `status は ${FEATURE_STATUSES.join(' / ')} のどれかにしてください（今は ${status ?? 'なし'}）`)
      continue
    }
    for (const k of Object.keys(d)) {
      if (INTERNAL_KEYS.includes(k)) add('error', f.file, 'internal', `「${k}」はシステムの裏側の項目です。設計書（${p.design}）かトラッキングプラン（${p.tracking}）に置いてください`)
    }
    if (!isText(d.name)) add('error', f.file, 'name', 'name がありません')
    if (!isList(d.platforms)) add('error', f.file, 'platforms', 'platforms（対応する OS）を書いてください')
    if (d.since_version == null || String(d.since_version).trim() === '') add('error', f.file, 'since_version', 'since_version（提供を始めたバージョン）を書いてください')
    checkActor(f.file, d.actors?.primary, 'actors.primary')
    for (const s of asArray(d.actors?.secondary)) checkActor(f.file, s, 'actors.secondary')
    if (!isList(d.jobs)) add('error', f.file, 'jobs', 'jobs（〜なとき、〜したい、そうすれば〜）を 1 つ以上書いてください')
    if (!isList(d.scenes)) add('error', f.file, 'scenes', 'scenes（利用シーン）を 1 つ以上書いてください')
    else d.scenes.forEach((s, i) => {
      if (!s || !isText(s.when)) add('error', f.file, 'scenes', `scenes[${i}] に when がありません`)
    })
    if (!isList(d.user_flows)) add('error', f.file, 'user_flows', 'user_flows（利用者から見た流れ）を 1 つ以上書いてください')
    else d.user_flows.forEach((u, i) => {
      if (!u || !isText(u.goal)) add('error', f.file, 'user_flows', `user_flows[${i}] に goal がありません`)
      if (!u || !isList(u.steps)) add('error', f.file, 'user_flows', `user_flows[${i}] に steps がありません`)
    })
    if (d.legacy === true) {
      if (!designsById.has(f.fileId)) add('warning', f.file, 'design', `既存の機能（legacy）ですが、設計書が ${p.design} にありません`)
    } else {
      if (!isList(d.requirements)) add('error', f.file, 'requirements', 'requirements（この機能を作った・変えた要件定義書）を書いてください。導入前からある機能なら legacy: true')
      for (const reqId of asArray(d.requirements)) {
        const r = reqById.get(reqId)
        if (!r) add('error', f.file, 'requirements', `requirements の ${reqId} がありません`)
        else if (r.data.status !== 'implemented') add('error', f.file, 'requirements', `requirements の ${reqId} が implemented ではありません（今は ${r.data.status}）`)
        else {
          const fs = reqFeatures(r)
          if (![...fs.new, ...fs.changed].includes(f.fileId)) add('error', f.file, 'requirements', `${reqId} の features（new / changed）に ${f.fileId} がありません`)
        }
      }
      if (!designsById.has(f.fileId)) add('error', f.file, 'design', `設計書が ${p.design} にありません`)
    }
    if (status === 'ga') {
      const h = d.help ?? {}
      if (!isText(h.summary)) add('error', f.file, 'help', 'help.summary（利用者向けの 1〜2 文）を書いてください')
      if (!isList(h.how_to)) add('error', f.file, 'help', 'help.how_to（手順）を書いてください')
      if (!Array.isArray(h.limitations)) add('error', f.file, 'help', 'help.limitations（できないこと）を書いてください。なければ []')
      if (!Array.isArray(h.synonyms)) add('error', f.file, 'help', 'help.synonyms（ユーザーの呼び方）を書いてください。なければ []')
      if (!['public', 'internal'].includes(h.visibility)) add('error', f.file, 'help', 'help.visibility は public か internal にしてください')
      if (h.visibility === 'public' && !isText(h.escalation)) add('error', f.file, 'help', 'help.escalation（解決しないときの問い合わせ先）を書いてください')
      if (!isList(d.changelog)) add('error', f.file, 'changelog', 'changelog を 1 つ以上書いてください')
      if (!DATE.test(String(d.last_reviewed ?? ''))) add('error', f.file, 'last_reviewed', 'last_reviewed（最終確認日 YYYY-MM-DD）を書いてください')
    }
    for (const [i, c] of asArray(d.changelog).entries()) {
      if (!c || c.version == null || !DATE.test(String(c.date ?? '')) || !isText(c.change)) {
        add('error', f.file, 'changelog', `changelog[${i}] には version・date（YYYY-MM-DD）・change を書いてください`)
      }
    }
    if (status === 'deprecated') {
      if (!DATE.test(String(d.deprecated_at ?? ''))) add('error', f.file, 'deprecated', 'deprecated_at（提供終了日 YYYY-MM-DD）を書いてください')
      if (!isText(d.alternative)) add('error', f.file, 'deprecated', 'alternative（代わりの手段。なければ「なし」）を書いてください')
    }
  }

  const errors = findings.filter((x) => x.level === 'error').length
  return {
    ok: errors === 0,
    errors,
    warnings: findings.length - errors,
    findings,
    counts: { requirements: requirements.length, designs: designs.length, features: features.length },
  }
}

// ---------------------------------------------------------------- 状態と次の番号

const NEXT = {
  draft: '要件定義を続ける（/feature-docs:requirements）。終わったら approved にして要件の PR を出す',
  approved: '設計と UI 案を作る（/feature-docs:design）',
  designed: '実装する（/feature-docs:build）。終わったら仕上げ（/feature-docs:finalize）',
  implemented: 'なし（完了）',
  rejected: 'なし（却下）',
  withdrawn: 'なし（取り下げ）',
}

export function status(repo) {
  const { requirements, features, designs } = loadAll(repo)
  return {
    requirements: requirements.map((r) => ({
      id: r.fileId,
      title: r.data.title ?? null,
      status: r.data.status ?? null,
      features: { new: asArray(r.data.features?.new), changed: asArray(r.data.features?.changed) },
      file: r.file,
      next: NEXT[r.data.status] ?? 'status を直す',
    })),
    features: features.map((f) => ({ id: f.fileId, name: f.data.name ?? null, status: f.data.status ?? null, file: f.file })),
    pending_designs: designs.filter((d) => asArray(d.data.pending).length).map((d) => ({ feature: d.fileId, pending: asArray(d.data.pending), file: d.file })),
  }
}

// 読めないファイルや、まだマージされていないブランチの番号ともぶつからないように、
// ファイル名と本文の ID を、作業ツリーと git のすべてのブランチ（origin も含む）から集める
function usedIds(repo, pattern) {
  const p = loadConfig(repo).paths
  const dirs = [p.requirements, p.design, p.features]
  const found = new Set()
  const scan = (text) => {
    for (const m of text.matchAll(pattern)) found.add(m[0])
  }
  for (const dir of dirs) {
    for (const f of listFiles(join(repo, dir))) {
      scan(f)
      if (dir === p.requirements) scan(readFileSync(join(repo, dir, f), 'utf8'))
    }
  }
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  try {
    const refs = git('for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes').split('\n').filter((r) => r && !r.endsWith('/HEAD'))
    for (const ref of refs) {
      scan(ref)
      scan(git('ls-tree', '-r', '--name-only', ref, '--', ...dirs))
      try {
        scan(git('grep', '-h', '-o', '-E', 'REQ-[0-9]{4,}|F-[0-9]{3,}', ref, '--', p.requirements))
      } catch {} // 一致なし
    }
  } catch {} // git のリポジトリでないとき
  return [...found]
}

export function nextId(repo, kind) {
  if (kind === 'req') {
    const n = Math.max(0, ...usedIds(repo, /REQ-\d{4,}/g).map((id) => Number(id.slice(4))))
    return `REQ-${String(n + 1).padStart(4, '0')}`
  }
  if (kind === 'feature') {
    const n = Math.max(0, ...usedIds(repo, /F-\d{3,}/g).map((id) => Number(id.slice(2))))
    return `F-${String(n + 1).padStart(3, '0')}`
  }
  throw new Error('next-id には req か feature を渡してください')
}

// ---------------------------------------------------------------- ヘルプ AI 用の書き出し

const q = (v) => JSON.stringify(String(v))
const fmValue = (v) => (Array.isArray(v) ? `[${v.map(q).join(', ')}]` : q(v))
const bullets = (items) => asArray(items).filter((x) => x != null && String(x).trim() !== '').map((x) => `- ${String(x).trim()}`).join('\n')

// 許可した項目だけを取り出す（拒否リストではないので、機能マスタに項目が増えても漏れない）
export function helpEntry(feature, actorsById) {
  const d = feature.data
  const h = d.help ?? {}
  const meta = {
    id: d.id,
    name: d.name,
    status: d.status,
    platforms: asArray(d.platforms).map(String),
    plans: asArray(d.plans).map(String),
    since_version: d.since_version != null ? String(d.since_version) : null,
    last_reviewed: d.last_reviewed != null ? String(d.last_reviewed) : null,
    synonyms: asArray(h.synonyms).map(String),
  }
  const parts = [`# ${d.name}`]
  const what = [h.summary, ...asArray(d.jobs).map((j) => `こんなときに: ${j}`)].filter(isText)
  if (what.length) parts.push(`## これは何？\n\n${what.join('\n\n')}`)
  const who = actorsById.get(d.actors?.primary)
  const scenes = asArray(d.scenes).map((s) => [s?.when, s?.situation].filter(isText).join('（') + (isText(s?.situation) ? '）' : ''))
  if (who || scenes.length) parts.push(`## 使う人と場面\n\n${[who ? `- 使う人: ${who.name}` : null, ...scenes.map((s) => `- ${s}`)].filter(Boolean).join('\n')}`)
  if (isList(h.how_to)) parts.push(`## 使い方\n\n${asArray(h.how_to).map((s, i) => `${i + 1}. ${String(s).trim()}`).join('\n')}`)
  for (const u of asArray(d.user_flows)) {
    if (!u) continue
    const lines = []
    if (isText(u.trigger)) lines.push(`- 始め方: ${u.trigger}`)
    for (const pre of asArray(u.preconditions)) lines.push(`- 前提: ${pre}`)
    asArray(u.steps).forEach((s, i) => lines.push(`${i + 1}. ${s}`))
    if (isText(u.result)) lines.push(`- 結果: ${u.result}`)
    const diff = asArray(u.when_things_differ).filter((w) => w && isText(w.condition) && isText(w.user_sees))
    if (diff.length) lines.push('', ...diff.map((w) => `- ${w.condition}: ${w.user_sees}`))
    if (lines.length) parts.push(`## ${u.goal ?? '流れ'}\n\n${lines.join('\n')}`)
  }
  const cannot = [...asArray(h.limitations), ...asArray(d.limits)]
  if (cannot.length) parts.push(`## できないこと・制限\n\n${bullets(cannot)}`)
  for (const t of asArray(h.troubleshooting)) {
    if (!t || !isText(t.symptom)) continue
    parts.push(`## うまくいかないとき: ${t.symptom}\n\n${[isText(t.cause) ? `- 原因: ${t.cause}` : null, isText(t.fix) ? `- 対処: ${t.fix}` : null].filter(Boolean).join('\n')}`)
  }
  for (const f of asArray(h.faq)) {
    if (!f || !isText(f.q) || !isText(f.a)) continue
    parts.push(`## よくある質問: ${f.q}\n\n${f.a}`)
  }
  if (isText(h.escalation)) parts.push(`## 解決しないとき\n\n${h.escalation}`)
  const log = asArray(d.changelog).filter((c) => c && isText(c.change))
  if (log.length) parts.push(`## 変更履歴\n\n${log.map((c) => `- ${c.version}（${c.date}）: ${c.change}`).join('\n')}`)
  const fm = Object.entries(meta)
    .filter(([, v]) => v != null && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${fmValue(v)}`)
    .join('\n')
  return { meta, markdown: `---\n${fm}\n---\n\n${parts.join('\n\n')}\n` }
}

export function exportHelp(repo, { out, force = false } = {}) {
  const check = runCheck(repo)
  if (!check.ok && !force) return { ok: false, written: [], skipped: [], check }
  const { config, features, actors, glossary } = loadAll(repo)
  const outDir = resolve(repo, out ?? config.paths.help_out)
  const actorsById = new Map(asArray(actors).filter((a) => a?.id).map((a) => [a.id, a]))
  const written = []
  const skipped = []
  const entries = []
  // 前回の書き出しを消してから書く（消えた機能が残らないように）
  if (existsSync(outDir)) for (const f of readdirSync(outDir)) if (/^F-\d+\.md$/.test(f) || f === 'index.json' || f === 'glossary.md') rmSync(join(outDir, f))
  mkdirSync(outDir, { recursive: true })
  for (const f of features) {
    const d = f.data
    if (!['beta', 'ga'].includes(d.status)) {
      skipped.push({ id: f.fileId, reason: `status が ${d.status}` })
      continue
    }
    if ((d.help?.visibility ?? 'internal') !== 'public') {
      skipped.push({ id: f.fileId, reason: 'help.visibility が public ではない' })
      continue
    }
    const { meta, markdown } = helpEntry(f, actorsById)
    const file = join(outDir, `${f.fileId}.md`)
    writeFileSync(file, markdown)
    written.push(file)
    entries.push({ ...meta, file: basename(file) })
  }
  const publicTerms = asArray(glossary).filter((t) => t && t.public === true && isText(t.term))
  if (publicTerms.length) {
    const md = publicTerms
      .map((t) => {
        const head = isText(t.user_facing) ? t.user_facing : t.term
        const lines = [isText(t.description) ? t.description : null]
        if (isList(t.synonyms)) lines.push(`言い方: ${t.synonyms.join('、')}`)
        if (isText(t.not_to_confuse)) lines.push(`取り違えに注意: ${t.not_to_confuse}`)
        return `## ${head}\n\n${lines.filter(Boolean).join('\n\n')}`
      })
      .join('\n\n')
    const file = join(outDir, 'glossary.md')
    writeFileSync(file, `# 用語\n\n${md}\n`)
    written.push(file)
  }
  const index = join(outDir, 'index.json')
  writeFileSync(index, JSON.stringify({ version: 1, features: entries }, null, 2) + '\n')
  written.push(index)
  return { ok: true, out: outDir, written, skipped, check }
}

// ---------------------------------------------------------------- CLI

function formatHuman(result) {
  const lines = []
  const { counts } = result
  lines.push(
    result.ok
      ? `feature-docs: 問題なし（要件定義書 ${counts.requirements}・設計書 ${counts.designs}・機能マスタ ${counts.features}）`
      : `feature-docs: 誤り ${result.errors} 件（要件定義書 ${counts.requirements}・設計書 ${counts.designs}・機能マスタ ${counts.features}）`,
  )
  for (const f of result.findings) lines.push(`${f.level === 'error' ? 'error' : 'warn '}  ${f.file}  [${f.rule}] ${f.message}`)
  return lines.join('\n')
}

export function main(argv) {
  const args = [...argv]
  const flag = (name) => {
    const i = args.indexOf(name)
    if (i === -1) return false
    args.splice(i, 1)
    return true
  }
  const option = (name) => {
    const i = args.indexOf(name)
    if (i === -1) return undefined
    const v = args[i + 1]
    args.splice(i, 2)
    return v
  }
  const json = flag('--json')
  const commands = ['check', 'status', 'next-id', 'export-help']
  const cmd = commands.includes(args[0]) ? args.shift() : 'check'
  if (cmd === 'next-id') {
    const kind = args.shift()
    const repo = resolve(args[0] ?? '.')
    console.log(nextId(repo, kind))
    return 0
  }
  if (cmd === 'status') {
    console.log(JSON.stringify(status(resolve(args[0] ?? '.')), null, 2))
    return 0
  }
  if (cmd === 'export-help') {
    const out = option('--out')
    const force = flag('--force')
    const result = exportHelp(resolve(args[0] ?? '.'), { out, force })
    if (!result.ok) {
      console.error(formatHuman(result.check))
      console.error('誤りがあるので書き出していません（--force で書き出せます）')
      return 1
    }
    console.log(JSON.stringify({ out: result.out, written: result.written.length, skipped: result.skipped }, null, 2))
    return 0
  }
  const result = runCheck(resolve(args[0] ?? '.'))
  console.log(json ? JSON.stringify(result, null, 2) : formatHuman(result))
  return result.ok ? 0 : 1
}

const isMain = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    console.error(`feature-docs: ${e.message}`)
    process.exitCode = 2
  }
}
