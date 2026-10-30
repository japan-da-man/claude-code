#!/usr/bin/env node
// observability のチェッカー。アプリのリポジトリの observability/check.mjs に写して使う（プラグインがなくても CI で動く）。
// 依存なし（Node 20 以上）。YAML は下の小さな読み込みで読む（手元と CI で結果が変わらないように、yaml パッケージは使わない）。
//
//   node observability/check.mjs [repo] [--json]   トラッキングプラン・アラート・runbook・障害の記録・コードを調べる（誤りがあれば終了コード 1）
//   node observability/check.mjs status [repo]     決めた観点と、置いたものの数を JSON で出す
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CONFIG_PATH = 'observability/config.json'

// 置き場所は observability/ に固定する（スキルとテンプレートがこの場所を前提にしている）
export const PATHS = {
  readme: 'observability/README.md',
  logging: 'observability/logging.md',
  events: 'observability/events.yaml',
  alerts: 'observability/alerts.yaml',
  runbooks: 'observability/runbooks',
  incidents: 'observability/incidents',
}

// 壁打ちで決める観点（順番どおりに決める）
export const PERSPECTIVES = ['scope', 'incident', 'logging', 'analytics', 'metrics', 'release', 'privacy', 'operations']

export const DEFAULT_CONFIG = {
  version: 1,
  progress: [],
  stacks: [],
  tools: {},
  events: {
    name_pattern: '^[a-z][a-z0-9]*(_[a-z0-9]+)+$',
    property_pattern: '^[a-z][a-z0-9]*(_[a-z0-9]+)*$',
    // プロパティ名をこの単語（_ で区切った一部でもよい）で書いたら、個人情報として止める。pii_reviewed に理由を書けば通す
    pii_words: ['email', 'mail', 'phone', 'tel', 'password', 'passwd', 'token', 'secret', 'address', 'fullname', 'firstname', 'lastname', 'birthday', 'birthdate', 'ip', 'card', 'ssn'],
  },
  severities: ['sev1', 'sev2', 'sev3'],
  runbook_sections: ['影響の確かめ方', '切り分け', '対処', 'エスカレーション'],
  incident_sections: ['概要', '影響', '時系列', '原因', '対処', '再発防止'],
  code: {
    dirs: ['.'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro', '.swift', '.kt', '.kts', '.java', '.dart', '.py', '.go', '.rb'],
    // ドットで始まるディレクトリ（.git・.yarn・.dart_tool など）はいつも読まない
    skip_dirs: ['node_modules', '.git', 'Pods', 'build', 'dist', '.next', '.expo', 'vendor', 'DerivedData', '.gradle', 'venv', '.venv', 'target', 'coverage'],
    // パス（リポジトリからの相対、/ 区切り）にこの正規表現が当たるファイルは読まない（テストなど）。直下の observability/ はいつも読まない
    exclude: [],
    // 計測の呼び出しからイベント名を取り出す正規表現。当たったグループのうち最初のものがイベント名（| で書き方を並べてよい）。フラグは g と m（^ は行の先頭）
    event_calls: [],
    // 書いてはいけないもの: { pattern, message, allow: [パスの正規表現], level: "error" | "warning" }
    forbidden: [],
  },
}

export const EVENT_STATUSES = ['planned', 'active', 'deprecated']
export const PROPERTY_TYPES = ['string', 'number', 'integer', 'boolean', 'enum', 'datetime', 'string_list']
export const INCIDENT_STATUSES = ['investigating', 'mitigated', 'resolved']

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/
const WINDOW = /^\d+[hdw]$/
const INCIDENT_FILE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*\.md$/

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
    ...structuredClone(DEFAULT_CONFIG),
    ...user,
    events: { ...DEFAULT_CONFIG.events, ...(user.events ?? {}) },
    code: { ...DEFAULT_CONFIG.code, ...(user.code ?? {}) },
  }
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v])
const isText = (v) => typeof v === 'string' && v.trim() !== ''
const posix = (p) => p.split(sep).join('/')

function listMarkdown(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && statSync(join(dir, f)).isFile())
    .sort()
}

function walk(root, dir, skip, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) {
      if (!skip.has(e.name) && !e.name.startsWith('.')) walk(root, join(dir, e.name), skip, out)
    } else if (e.isFile()) out.push(posix(relative(root, join(dir, e.name))))
  }
  return out
}

function compile(pattern, flags, where, add) {
  try {
    return new RegExp(pattern, flags)
  } catch (e) {
    add('error', CONFIG_PATH, 'config', `${where} の正規表現が読めません: ${e.message}`)
    return null
  }
}

// コードに当てる正規表現。空文字に当たるもの（空の pattern など）は、ファイルのすべての位置に当たるので弾く
function compileCode(pattern, where, add) {
  if (!isText(pattern)) {
    add('error', CONFIG_PATH, 'config', `${where} がありません`)
    return null
  }
  const re = compile(pattern, 'gm', where, add)
  if (re && new RegExp(re.source, 'm').test('')) {
    add('error', CONFIG_PATH, 'config', `${where} が空の文字に当たります: ${pattern}`)
    return null
  }
  return re
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length

// ---------------------------------------------------------------- チェック

export function runCheck(repo) {
  const findings = []
  const add = (level, file, rule, message) => findings.push({ level, file, rule, message })
  const counts = { events: 0, slos: 0, alerts: 0, runbooks: 0, incidents: 0, files_scanned: 0 }

  let config
  try {
    config = loadConfig(repo)
  } catch (e) {
    add('error', CONFIG_PATH, 'config', `読めません: ${e.message}`)
    return finish(findings, counts)
  }
  for (const id of asArray(config.progress)) {
    if (!PERSPECTIVES.includes(id)) add('error', CONFIG_PATH, 'config', `progress の「${id}」は観点ではありません（${PERSPECTIVES.join(' / ')}）`)
  }
  const p = PATHS

  const readYaml = (rel) => {
    const abs = join(repo, rel)
    if (!existsSync(abs)) return undefined
    try {
      return parseYaml(readFileSync(abs, 'utf8')) ?? {}
    } catch (e) {
      add('error', rel, 'parse', e.message)
      return null
    }
  }

  // ---- トラッキングプラン
  const events = new Map()
  const plan = readYaml(p.events)
  if (plan) {
    const nameRe = compile(config.events.name_pattern, '', 'events.name_pattern', add)
    const propRe = compile(config.events.property_pattern, '', 'events.property_pattern', add)
    const piiWords = new Set(asArray(config.events.pii_words).map((w) => String(w).toLowerCase()))
    const looksPii = (name) => {
      const parts = String(name).toLowerCase().split('_')
      // first_name のような 2 語の言い方も拾う
      return parts.some((w, i) => piiWords.has(w) || piiWords.has(w + (parts[i + 1] ?? '')))
    }
    const checkProps = (props, where, globalNames) => {
      if (props == null) return
      if (!Array.isArray(props)) {
        add('error', p.events, 'property', `${where}: リストにしてください`)
        return null
      }
      const seen = new Set()
      for (const prop of props) {
        const name = prop?.name
        if (!isText(name)) {
          add('error', p.events, 'property', `${where}: name のないプロパティがあります`)
          continue
        }
        const label = `${where}.${name}`
        if (seen.has(name)) add('error', p.events, 'property', `${label}: 名前が重複しています`)
        seen.add(name)
        if (propRe && !propRe.test(name)) add('error', p.events, 'property', `${label}: 名前が ${config.events.property_pattern} の形ではありません`)
        if (globalNames?.has(name)) add('warning', p.events, 'property', `${label}: 共通のプロパティと同じ名前です（上書きになります）`)
        if (!PROPERTY_TYPES.includes(prop.type)) add('error', p.events, 'property', `${label}: type は ${PROPERTY_TYPES.join(' / ')} のどれかです`)
        if (prop.type === 'enum' && !(Array.isArray(prop.values) && prop.values.length)) add('error', p.events, 'property', `${label}: enum には values が必要です`)
        if (!isText(prop.description)) add('warning', p.events, 'property', `${label}: description がありません`)
        if (prop.pii === true) add('error', p.events, 'pii', `${label}: 個人情報（pii: true）はイベントに入れません`)
        else if (looksPii(name) && !isText(prop.pii_reviewed)) add('error', p.events, 'pii', `${label}: 個人情報に見える名前です。送らないか、個人情報でない理由を pii_reviewed に書いてください`)
      }
      return seen
    }
    const globals = checkProps(plan.global_properties, 'global_properties') ?? new Set()
    if (plan.events != null && !Array.isArray(plan.events)) add('error', p.events, 'events', 'events はリストにしてください')
    const allNames = new Set(asArray(plan.events).map((e) => e?.name))
    for (const ev of asArray(plan.events)) {
      const name = ev?.name
      if (!isText(name)) {
        add('error', p.events, 'events', 'name のないイベントがあります')
        continue
      }
      counts.events++
      if (events.has(name)) add('error', p.events, 'event_name', `${name}: 名前が重複しています`)
      if (nameRe && !nameRe.test(name)) add('error', p.events, 'event_name', `${name}: 名前が ${config.events.name_pattern} の形ではありません`)
      for (const key of ['description', 'owner']) if (!isText(ev[key])) add('error', p.events, 'events', `${name}: ${key} がありません`)
      if (!EVENT_STATUSES.includes(ev.status)) add('error', p.events, 'events', `${name}: status は ${EVENT_STATUSES.join(' / ')} のどれかです`)
      if (!isText(ev.trigger)) add('warning', p.events, 'events', `${name}: trigger（いつ送るか）がありません`)
      if (ev.replaced_by != null && !allNames.has(ev.replaced_by)) add('error', p.events, 'events', `${name}: replaced_by の「${ev.replaced_by}」がありません`)
      checkProps(ev.properties, name, globals)
      events.set(name, ev.status)
    }
  }

  // ---- SLO とアラート
  const alerts = readYaml(p.alerts)
  const referenced = new Set()
  if (alerts) {
    const slos = new Set()
    for (const slo of asArray(alerts.slos)) {
      const id = slo?.id
      if (!isText(id) || !KEBAB.test(id)) {
        add('error', p.alerts, 'slo', `SLO の id「${id ?? ''}」は kebab-case にしてください`)
        continue
      }
      counts.slos++
      if (slos.has(id)) add('error', p.alerts, 'slo', `${id}: id が重複しています`)
      slos.add(id)
      if (!isText(slo.sli)) add('error', p.alerts, 'slo', `${id}: sli（何を測るか）がありません`)
      if (typeof slo.target !== 'number' || !(slo.target > 0 && slo.target < 100)) add('error', p.alerts, 'slo', `${id}: target は 0 より大きく 100 より小さい数（%）にしてください`)
      if (!WINDOW.test(String(slo.window ?? ''))) add('error', p.alerts, 'slo', `${id}: window は 30d・4w・24h の形にしてください`)
    }
    const ids = new Set()
    for (const alert of asArray(alerts.alerts)) {
      const id = alert?.id
      if (!isText(id) || !KEBAB.test(id)) {
        add('error', p.alerts, 'alert', `アラートの id「${id ?? ''}」は kebab-case にしてください`)
        continue
      }
      counts.alerts++
      if (ids.has(id)) add('error', p.alerts, 'alert', `${id}: id が重複しています`)
      ids.add(id)
      if (!config.severities.includes(alert.severity)) add('error', p.alerts, 'alert', `${id}: severity は ${config.severities.join(' / ')} のどれかです`)
      for (const key of ['condition', 'notify']) if (!isText(alert[key])) add('error', p.alerts, 'alert', `${id}: ${key} がありません`)
      if (alert.slo != null && !slos.has(alert.slo)) add('error', p.alerts, 'alert', `${id}: slo の「${alert.slo}」がありません`)
      if (!isText(alert.runbook)) {
        add('error', p.alerts, 'runbook', `${id}: runbook がありません`)
        continue
      }
      const rb = posix(alert.runbook)
      referenced.add(rb)
      const abs = join(repo, rb)
      if (!existsSync(abs)) {
        add('error', p.alerts, 'runbook', `${id}: runbook の ${rb} がありません`)
        continue
      }
      try {
        const { headings } = parseMarkdown(readFileSync(abs, 'utf8'))
        const missing = config.runbook_sections.filter((s) => !headings.includes(s))
        if (missing.length) add('error', rb, 'runbook', `節がありません: ${missing.join('、')}`)
      } catch (e) {
        add('error', rb, 'parse', e.message)
      }
    }
  }
  for (const f of listMarkdown(join(repo, p.runbooks))) {
    counts.runbooks++
    const rel = posix(join(p.runbooks, f))
    if (f.startsWith('_') || f === 'README.md') continue
    if (!referenced.has(rel)) add('warning', rel, 'runbook', 'どのアラートからも指されていません')
  }

  // ---- 障害の記録
  for (const f of listMarkdown(join(repo, p.incidents))) {
    if (f === 'README.md' || f.startsWith('_')) continue
    counts.incidents++
    const rel = posix(join(p.incidents, f))
    if (!INCIDENT_FILE.test(f)) add('warning', rel, 'incident', 'ファイル名は YYYY-MM-DD-<name>.md にしてください')
    let doc
    try {
      doc = parseMarkdown(readFileSync(join(repo, rel), 'utf8'))
    } catch (e) {
      add('error', rel, 'parse', e.message)
      continue
    }
    const { data, headings } = doc
    if (!config.severities.includes(data.severity)) add('error', rel, 'incident', `severity は ${config.severities.join(' / ')} のどれかです`)
    if (!INCIDENT_STATUSES.includes(data.status)) add('error', rel, 'incident', `status は ${INCIDENT_STATUSES.join(' / ')} のどれかです`)
    if (!isText(String(data.started_at ?? ''))) add('error', rel, 'incident', 'started_at がありません')
    if (data.status === 'resolved') {
      const missing = config.incident_sections.filter((s) => !headings.includes(s))
      if (missing.length) add('error', rel, 'incident', `resolved にはポストモーテムの節が必要です: ${missing.join('、')}`)
    }
  }

  // ---- コード
  const code = config.code
  const calls = asArray(code.event_calls).map((s, i) => compileCode(s, `code.event_calls[${i}]`, add))
  const forbidden = asArray(code.forbidden).map((rule, i) => ({
    rule,
    re: compileCode(rule?.pattern, `code.forbidden[${i}].pattern`, add),
    allow: asArray(rule?.allow).map((a, j) => compile(a, '', `code.forbidden[${i}].allow[${j}]`, add)).filter(Boolean),
  }))
  const exclude = asArray(code.exclude).map((s, i) => compile(s, '', `code.exclude[${i}]`, add)).filter(Boolean)
  // 空文字に当たる「|」を足して、グループの数を数える
  if (calls.some((re) => re && new RegExp(`${re.source}|`).exec('').length < 2)) add('error', CONFIG_PATH, 'config', 'code.event_calls にはイベント名を取り出すグループ ( ) が必要です')

  if (calls.length || forbidden.length) {
    const exts = new Set(asArray(code.extensions))
    const skip = new Set(asArray(code.skip_dirs))
    const files = new Set()
    for (const d of asArray(code.dirs)) for (const f of walk(repo, join(repo, d), skip, [])) files.add(f)
    const used = new Map()
    for (const file of [...files].sort()) {
      const dot = file.lastIndexOf('.')
      if (dot === -1 || !exts.has(file.slice(dot))) continue
      // 直下の observability/ は、このチェッカー自身と運用文書
      if (file.startsWith('observability/') || exclude.some((re) => re.test(file))) continue
      let text
      try {
        text = readFileSync(join(repo, file), 'utf8')
      } catch {
        continue
      }
      counts.files_scanned++
      for (const re of calls) {
        if (!re) continue
        re.lastIndex = 0
        for (const m of text.matchAll(re)) {
          const name = m.slice(1).find((g) => g != null)
          if (name == null) continue
          const at = `${file}:${lineOf(text, m.index)}`
          if (!used.has(name)) used.set(name, at)
          const st = events.get(name)
          if (st == null) add('error', at, 'code_event', `イベント「${name}」がトラッキングプラン（${p.events}）にありません`)
          else if (st === 'planned') add('warning', at, 'code_event', `イベント「${name}」は planned です。送り始めたなら status を active にしてください`)
          else if (st === 'deprecated') add('warning', at, 'code_event', `イベント「${name}」は deprecated です`)
        }
      }
      for (const { rule, re, allow } of forbidden) {
        if (!re || allow.some((a) => a.test(file))) continue
        re.lastIndex = 0
        for (const m of text.matchAll(re)) {
          add(rule.level === 'warning' ? 'warning' : 'error', `${file}:${lineOf(text, m.index)}`, 'code_forbidden', rule.message || `書いてはいけない書き方です: ${rule.pattern}`)
        }
      }
    }
    if (calls.length && plan) {
      for (const [name, st] of events) {
        if (st === 'active' && !used.has(name)) add('warning', p.events, 'code_event', `${name}: active なのに、コードで送っているところが見つかりません`)
      }
    }
  }

  return finish(findings, counts)
}

function finish(findings, counts) {
  const errors = findings.filter((f) => f.level === 'error').length
  return { ok: errors === 0, errors, warnings: findings.length - errors, counts, findings }
}

export function status(repo) {
  const config = loadConfig(repo)
  const decided = PERSPECTIVES.filter((id) => asArray(config.progress).includes(id))
  const remaining = PERSPECTIVES.filter((id) => !decided.includes(id))
  const { counts } = runCheck(repo)
  return {
    installed: existsSync(join(repo, CONFIG_PATH)),
    stacks: config.stacks,
    tools: config.tools,
    progress: { decided, remaining, next: remaining[0] ?? null },
    counts,
  }
}

// ---------------------------------------------------------------- CLI

function formatHuman(result) {
  const { counts } = result
  const summary = `イベント ${counts.events}・SLO ${counts.slos}・アラート ${counts.alerts}・runbook ${counts.runbooks}・障害の記録 ${counts.incidents}・調べたファイル ${counts.files_scanned}`
  const lines = [result.ok ? `observability: 問題なし（${summary}）` : `observability: 誤り ${result.errors} 件（${summary}）`]
  for (const f of result.findings) lines.push(`${f.level === 'error' ? 'error' : 'warn '}  ${f.file}  [${f.rule}] ${f.message}`)
  return lines.join('\n')
}

export function main(argv) {
  const args = [...argv]
  const i = args.indexOf('--json')
  const json = i !== -1
  if (json) args.splice(i, 1)
  if (args[0] === 'status') {
    console.log(JSON.stringify(status(resolve(args[1] ?? '.')), null, 2))
    return 0
  }
  if (args[0] === 'check') args.shift()
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
    console.error(`observability: ${e.message}`)
    process.exitCode = 2
  }
}
