// デザインシステムのチェック。product-design プラグインから、アプリのリポジトリの design-system/check.mjs に写して使う。
// 手で直さない（/product-design:init と /product-design:update がプラグインの版で上書きする）。
// Node の標準機能だけで動き、このファイルだけで完結する。
//
//   node design-system/check.mjs [--json] [--strict] [--repo <path>]
//
// 調べること:
//   - tokens.json が DTCG 2025.10 の形で、必ずある役割がそろい、文字と背景の組のコントラストが足りているか
//   - 原則・基礎・部品・パターン・文言・トークンが、上の段の ID を根拠に持っているか（trace-*）
//   - 未決の候補（docs/design-candidates/ の status: open）
// 終了コード: 0 = 通った、1 = アプリのコードの違反（--strict のときはデザインシステムの中の不備も）、2 = チェックが成り立たない。
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CONFIG_PATH = 'design-system/design-system.json'
export const NS = 'com.github.japan-da-man.product-design'
const DS_DIR = dirname(CONFIG_PATH)

// 意味の段の必ずある役割（ひな形の部品が使う）。文字の段はどちらの土台も Dynamic Type の名前。
const TEXT_STYLES = ['large-title', 'title-1', 'title-2', 'title-3', 'headline', 'body', 'callout', 'subheadline', 'footnote', 'caption-1', 'caption-2']
const COMMON = {
  font: TEXT_STYLES,
  space: ['1', '2', '3', '4', '5', '6', '7', '8'],
  radius: ['sm', 'md', 'lg'],
  shadow: ['sm', 'md'],
  duration: ['fast', 'normal'],
  easing: ['standard'],
}
export const REQUIRED = {
  hig: {
    color: [
      'tint', 'label', 'secondary-label', 'tertiary-label', 'placeholder-text', 'separator', 'fill', 'secondary-fill',
      'system-background', 'secondary-system-background', 'system-grouped-background', 'secondary-system-grouped-background',
      'on-tint', 'destructive', 'warning', 'success', 'info',
    ],
    ...COMMON,
  },
  shadcn: {
    color: [
      'background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground', 'primary', 'primary-foreground',
      'secondary', 'secondary-foreground', 'muted', 'muted-foreground', 'accent', 'accent-foreground', 'destructive',
      'border', 'input', 'ring', 'success', 'success-foreground', 'warning', 'warning-foreground', 'info', 'info-foreground',
    ],
    ...COMMON,
  },
}

// swiftui.system に書ける名前: UIKit の意味の色（Color(uiColor:) で包む）と accentColor。
export const SYSTEM_COLORS = [
  'accentColor', 'label', 'secondaryLabel', 'tertiaryLabel', 'quaternaryLabel', 'placeholderText', 'link', 'separator', 'opaqueSeparator',
  'systemFill', 'secondarySystemFill', 'tertiarySystemFill', 'quaternarySystemFill',
  'systemBackground', 'secondarySystemBackground', 'tertiarySystemBackground',
  'systemGroupedBackground', 'secondarySystemGroupedBackground', 'tertiarySystemGroupedBackground',
  'systemRed', 'systemOrange', 'systemYellow', 'systemGreen', 'systemMint', 'systemTeal', 'systemCyan', 'systemBlue',
  'systemIndigo', 'systemPurple', 'systemPink', 'systemBrown', 'systemGray', 'systemGray2', 'systemGray3', 'systemGray4', 'systemGray5', 'systemGray6',
]

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ALIAS = /^\{([^{}]+)\}$/
const STAGES = ['product', 'design', 'foundations', 'components', 'outputs']
const CANDIDATE_STATUS = ['open', 'adopted', 'exception', 'rejected']
const COMPONENT_STATUS = ['draft', 'stable', 'deprecated']

const posix = (p) => p.split(sep).join('/')
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const ext = (node) => (isObject(node?.$extensions?.[NS]) ? node.$extensions[NS] : {})

// ---------------------------------------------------------------------------
// トークン

// DTCG のファイルを、道のり（color.tint）からトークンへの Map にする。グループの $type と、このプラグインの from を受け継ぐ。
export function flattenTokens(root) {
  const tokens = new Map()
  const errors = []
  const walk = (node, path, type, from) => {
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$')) continue
      const p = [...path, key]
      const name = p.join('.')
      if (!NAME.test(key)) errors.push(`"${name}" の名前は小文字の kebab-case か数字にしてください`)
      if (!isObject(child)) {
        errors.push(`"${name}" はトークン（$value を持つ）かグループ（オブジェクト）にしてください`)
        continue
      }
      const childType = child.$type ?? type
      const childFrom = Array.isArray(ext(child).from) ? ext(child).from : from
      if ('$value' in child) {
        if (!path.length) errors.push(`"${name}" は最上位に置かずに、グループ（color・space など）の中に置いてください`)
        tokens.set(name, {
          path: name,
          group: p[0],
          tier: p[0] === 'primitive' ? 'primitive' : 'semantic',
          type: child.$type ?? type,
          value: child.$value,
          description: child.$description,
          deprecated: child.$deprecated,
          from: childFrom,
          ext: ext(child),
        })
      } else walk(child, p, childType, childFrom)
    }
  }
  if (!isObject(root)) return { tokens, errors: ['tokens.json が JSON のオブジェクトではありません'] }
  walk(root, [], root.$type, undefined)
  return { tokens, errors }
}

// 別名をたどって、最後のトークンを返す。見つからない・循環しているときは error。
export function resolveAlias(tokens, ref, seen = []) {
  const m = typeof ref === 'string' ? ALIAS.exec(ref) : null
  if (!m) return { value: ref }
  const target = tokens.get(m[1])
  if (!target) return { error: `参照先 ${ref} がありません` }
  if (seen.includes(m[1])) return { error: `別名が循環しています（${[...seen, m[1]].join(' → ')}）` }
  const r = resolveAlias(tokens, target.value, [...seen, m[1]])
  return r.error ? r : { value: r.value, token: r.token ?? target }
}

// 別名の鎖に並ぶトークン（循環していたら途中まで）。
function aliasChain(tokens, ref) {
  const chain = []
  let m = typeof ref === 'string' ? ALIAS.exec(ref) : null
  while (m && tokens.has(m[1]) && !chain.some((c) => c.path === m[1])) {
    const t = tokens.get(m[1])
    chain.push(t)
    m = typeof t.value === 'string' ? ALIAS.exec(t.value) : null
  }
  return chain
}

// 値の中の別名をすべて解決する（合成型の中も）。
function deepResolve(tokens, value, errors, where) {
  if (typeof value === 'string' && ALIAS.test(value)) {
    const r = resolveAlias(tokens, value)
    if (r.error) {
      errors.push(`${where}: ${r.error}`)
      return undefined
    }
    return deepResolve(tokens, r.value, errors, where)
  }
  if (Array.isArray(value)) return value.map((v) => deepResolve(tokens, v, errors, where))
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepResolve(tokens, v, errors, where)]))
  return value
}

// 別名だけのトークンは、参照先の型を受け継ぐ。
function typeOf(tokens, t) {
  if (t.type) return t.type
  const r = resolveAlias(tokens, t.value)
  return r.token?.type
}

const num = (v) => typeof v === 'number' && Number.isFinite(v)
const VALIDATORS = {
  color: (v) =>
    isObject(v) && v.colorSpace === 'srgb' && Array.isArray(v.components) && v.components.length === 3 && v.components.every((c) => num(c) && c >= 0 && c <= 1) && (v.alpha === undefined || (num(v.alpha) && v.alpha >= 0 && v.alpha <= 1))
      ? null
      : 'color は { colorSpace: "srgb", components: [r, g, b]（0〜1）, alpha?, hex? } にしてください',
  dimension: (v) => (isObject(v) && num(v.value) && ['px', 'rem'].includes(v.unit) ? null : 'dimension は { value, unit: "px" | "rem" } にしてください'),
  duration: (v) => (isObject(v) && num(v.value) && ['ms', 's'].includes(v.unit) ? null : 'duration は { value, unit: "ms" | "s" } にしてください'),
  cubicBezier: (v) => (Array.isArray(v) && v.length === 4 && v.every(num) && v[0] >= 0 && v[0] <= 1 && v[2] >= 0 && v[2] <= 1 ? null : 'cubicBezier は [x1, y1, x2, y2]（x は 0〜1）にしてください'),
  number: (v) => (num(v) ? null : 'number は数にしてください'),
  fontFamily: (v) => (typeof v === 'string' || (Array.isArray(v) && v.length && v.every((s) => typeof s === 'string')) ? null : 'fontFamily は文字列か文字列の配列にしてください'),
  fontWeight: (v) => ((num(v) && v >= 1 && v <= 1000) || typeof v === 'string' ? null : 'fontWeight は 1〜1000 の数にしてください'),
  typography: (v) => {
    if (!isObject(v)) return 'typography は { fontFamily, fontSize, fontWeight, lineHeight, letterSpacing } にしてください'
    for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight']) if (v[k] === undefined) return `typography に ${k} がありません`
    return VALIDATORS.fontFamily(v.fontFamily) ?? VALIDATORS.dimension(v.fontSize) ?? VALIDATORS.fontWeight(v.fontWeight) ?? (num(v.lineHeight) ? null : 'typography の lineHeight は文字の大きさに対する比（数）にしてください')
  },
  shadow: (v) => {
    const one = (s) =>
      isObject(s) && VALIDATORS.color(s.color) === null && ['offsetX', 'offsetY', 'blur', 'spread'].every((k) => VALIDATORS.dimension(s[k]) === null)
        ? null
        : 'shadow は { color, offsetX, offsetY, blur, spread } にしてください'
    return Array.isArray(v) ? v.map(one).find(Boolean) ?? null : one(v)
  },
}

// 色の値を [r, g, b, a] にする。
export function rgba(v) {
  return [...v.components, v.alpha ?? 1]
}

// 意味の段のトークンの色を、ライトとダークで解決する（ダークは $extensions の modes.dark、なければライトと同じ）。
export function colorModes(tokens, path) {
  const t = tokens.get(path)
  if (!t) return null
  const light = deepResolve(tokens, t.value, [], path)
  const darkRef = t.ext.modes?.dark
  const dark = darkRef === undefined ? light : deepResolve(tokens, darkRef, [], path)
  if (VALIDATORS.color(light) || VALIDATORS.color(dark)) return null
  return { light: rgba(light), dark: rgba(dark) }
}

export function validateTokens(root, base) {
  const { tokens, errors } = flattenTokens(root)
  const warnings = []
  const deprecated = []
  for (const t of tokens.values()) {
    const type = typeOf(tokens, t)
    const where = `"${t.path}"`
    if (!type) {
      errors.push(`${where} の $type がありません（トークンか、それを含むグループに書く）`)
      continue
    }
    const value = deepResolve(tokens, t.value, errors, where)
    if (value === undefined) continue
    const bad = VALIDATORS[type]?.(value)
    if (bad) errors.push(`${where}: ${bad}`)
    const retired = t.deprecated === undefined && aliasChain(tokens, t.value).find((c) => c.deprecated !== undefined)
    if (retired) deprecated.push(`${where} が、廃止されたトークン "${retired.path}" を使っています`)

    const { modes, swiftui, textStyle } = t.ext
    if (modes !== undefined) {
      if (!isObject(modes) || Object.keys(modes).some((k) => k !== 'dark')) errors.push(`${where} の modes に書けるのは dark だけです`)
      else if (modes.dark !== undefined) {
        const dark = deepResolve(tokens, modes.dark, errors, `${where} の modes.dark`)
        const badDark = dark !== undefined && VALIDATORS[type]?.(dark)
        if (badDark) errors.push(`${where} の modes.dark: ${badDark}`)
      }
    }
    if (swiftui?.system !== undefined) {
      if (type !== 'color') errors.push(`${where}: swiftui.system は色のトークンにだけ書けます`)
      else if (!SYSTEM_COLORS.includes(swiftui.system)) errors.push(`${where}: swiftui.system "${swiftui.system}" は書けない名前です（UIKit の意味の色か accentColor）`)
    }
    if (type === 'typography' && t.tier === 'semantic' && !TEXT_STYLES.includes(textStyle)) {
      errors.push(`${where}: 文字のトークンには $extensions の textStyle（${TEXT_STYLES.join('・')} のどれか）が要ります`)
    }
  }
  const required = REQUIRED[base]
  if (!required) errors.push(`base "${base}" は hig か shadcn にしてください`)
  else {
    for (const [group, names] of Object.entries(required)) {
      for (const name of names) if (!tokens.has(`${group}.${name}`)) errors.push(`必ずある役割 "${group}.${name}" がありません`)
    }
  }
  return { tokens, errors, warnings, deprecated }
}

// ---------------------------------------------------------------------------
// コントラスト（WCAG 2.x）

function luminance([r, g, b]) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

// 透明度のある色を、不透明な下地に重ねる。
export function composite([r, g, b, a], [br, bg, bb]) {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1]
}

export function contrastRatio(fg, bg) {
  const [l1, l2] = [luminance(fg), luminance(bg)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

const MIN = { text: 4.5, 'large-text': 3, ui: 3 }

// 組は tokens.json の最上位の $extensions の contrast に、{ fg, bg, over?, kind? } で書く（fg・bg・over は color の役割の名前）。
export function checkContrast(root, tokens) {
  const errors = []
  const warnings = []
  const pairs = ext(root).contrast ?? []
  if (!Array.isArray(pairs)) return { errors: ['$extensions の contrast は配列にしてください'], warnings }
  for (const pair of pairs) {
    const { fg, bg, over, kind = 'text' } = pair ?? {}
    const label = `コントラスト ${fg} → ${bg}`
    if (!MIN[kind]) {
      errors.push(`${label}: kind は text・large-text・ui のどれかにしてください`)
      continue
    }
    const f = colorModes(tokens, `color.${fg}`)
    const b = colorModes(tokens, `color.${bg}`)
    const o = over === undefined ? null : colorModes(tokens, `color.${over}`)
    if (!f || !b || (over !== undefined && !o)) {
      errors.push(`${label}: 色の役割が見つからないか、色の値が読めません`)
      continue
    }
    for (const mode of ['light', 'dark']) {
      let back = b[mode]
      if (back[3] < 1) {
        if (!o) {
          errors.push(`${label}（${mode}）: 背景が半透明なので、何の上に重ねるかを over に書いてください`)
          continue
        }
        back = composite(back, o[mode])
      }
      const ratio = contrastRatio(composite(f[mode], back), back)
      if (ratio + 1e-9 >= MIN[kind]) continue
      const pinned = tokens.get(`color.${fg}`)?.ext.swiftui?.system
      const hint = pinned && pinned !== 'accentColor' ? '。濃くするには swiftui.system を外して独自の値にする' : ''
      const msg = `${label}（${mode}）が ${ratio.toFixed(2)}:1 で、${MIN[kind]}:1 に届きません${hint}`
      ;(kind === 'ui' ? warnings : errors).push(msg)
    }
  }
  return { errors, warnings }
}

// ---------------------------------------------------------------------------
// 文書

// 先頭のメタデータ（--- で囲んだ YAML の一部）を読む。読めるのは key: 値、[a, b]、{ k: v }、- の箇条、# のコメント。
export function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { data: null, body: text }
  const data = {}
  let listKey = null
  for (const raw of m[1].split(/\r?\n/)) {
    const line = stripComment(raw)
    if (!line.trim()) continue
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line)
    if (item && listKey) {
      data[listKey].push(scalar(item[1]))
      continue
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    listKey = null
    if (kv[2] === '') {
      data[kv[1]] = []
      listKey = kv[1]
    } else data[kv[1]] = yamlValue(kv[2])
  }
  return { data, body: text.slice(m[0].length) }
}

function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd()
  }
  return line
}

function splitTop(s) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const c of s) {
    if (c === '[' || c === '{') depth++
    if (c === ']' || c === '}') depth--
    if (c === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur.trim()) parts.push(cur)
  return parts.map((p) => p.trim())
}

function scalar(s) {
  const t = s.trim()
  if (/^".*"$|^'.*'$/.test(t)) return t.slice(1, -1)
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t)
  if (t === 'true' || t === 'false') return t === 'true'
  return t
}

function yamlValue(s) {
  const t = s.trim()
  if (t.startsWith('[') && t.endsWith(']')) return splitTop(t.slice(1, -1)).filter(Boolean).map(yamlValue)
  if (t.startsWith('{') && t.endsWith('}')) {
    return Object.fromEntries(
      splitTop(t.slice(1, -1))
        .filter(Boolean)
        .map((p) => {
          const i = p.indexOf(':')
          return [p.slice(0, i).trim(), yamlValue(p.slice(i + 1))]
        }),
    )
  }
  return scalar(t)
}

const ID_LIST = /^根拠[:：]\s*(.*)$/

function idsIn(text) {
  return text
    .split(/[,、，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// 原則の文書（### P1 … / ### D1 …）を読む。見出しの次の空でない行が「根拠: …」なら根拠。## 廃止 の下は廃止。
export function readPrinciples(text, prefix) {
  const ids = new Map()
  const errors = []
  const lines = text.split(/\r?\n/)
  let retired = false
  const heading = new RegExp(`^###\\s+(${prefix}\\d+)\\b`)
  lines.forEach((line, i) => {
    if (/^##\s/.test(line)) retired = /^##\s+廃止\s*$/.test(line)
    const m = heading.exec(line)
    if (!m) return
    if (ids.has(m[1])) errors.push(`${m[1]} が 2 回出てきます（${i + 1} 行目）`)
    ids.set(m[1], { line: i + 1, retired, refs: nextRefs(lines, i) })
  })
  return { ids, errors }
}

function nextRefs(lines, i) {
  for (let j = i + 1; j < lines.length; j++) {
    if (!lines[j].trim()) continue
    const m = ID_LIST.exec(lines[j].trim())
    return m ? idsIn(m[1]) : null
  }
  return null
}

// 決まりの文書（foundations・patterns・copy）の ## の節ごとの根拠を読む。## 廃止 は数えない。
export function readSections(text) {
  const sections = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (!m || /^#{3}/.test(line) || m[1] === '廃止') return
    sections.push({ title: m[1], line: i + 1, refs: nextRefs(lines, i) })
  })
  return sections
}

// ---------------------------------------------------------------------------
// 根拠のつながり

const RULE_DOCS = ['foundations.md', 'patterns.md', 'copy.md']

function readIfExists(repo, rel) {
  const abs = join(repo, rel)
  return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null
}

function mdFiles(repo, dir) {
  const abs = join(repo, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs)
    .filter((n) => n.endsWith('.md') && n !== 'README.md')
    .sort()
    .map((n) => posix(join(dir, n)))
}

// 根拠をたどれる形で、文書とトークンの「使う側 → 使われる ID」を集める。
export function collectTrace(repo, config, tokens) {
  const errors = []
  const product = readIfExists(repo, config.product_principles)
  const designFile = posix(join(DS_DIR, 'principles.md'))
  const design = readIfExists(repo, designFile)
  if (product === null) errors.push(`${config.product_principles} がありません`)
  if (design === null) errors.push(`${designFile} がありません`)
  const P = product === null ? { ids: new Map(), errors: [] } : readPrinciples(product, 'P')
  const D = design === null ? { ids: new Map(), errors: [] } : readPrinciples(design, 'D')
  errors.push(...P.errors.map((e) => `${config.product_principles}: ${e}`), ...D.errors.map((e) => `${designFile}: ${e}`))

  // users: { where, layer, refs, retired }
  const users = []
  for (const [id, d] of D.ids) users.push({ where: `${designFile}:${d.line} ${id}`, layer: 'D', refs: d.refs, retired: d.retired, id })
  for (const name of RULE_DOCS) {
    const file = posix(join(DS_DIR, name))
    const text = readIfExists(repo, file)
    if (text === null) {
      errors.push(`${file} がありません`)
      continue
    }
    for (const s of readSections(text)) users.push({ where: `${file}:${s.line} ${s.title}`, layer: 'rule', refs: s.refs })
  }
  const componentsDir = config.components ?? posix(join(DS_DIR, 'components'))
  for (const file of mdFiles(repo, componentsDir)) {
    const { data } = parseFrontMatter(readFileSync(join(repo, file), 'utf8'))
    if (!data) {
      errors.push(`${file}: 先頭のメタデータ（--- で囲む）がありません`)
      continue
    }
    if (!COMPONENT_STATUS.includes(data.status)) errors.push(`${file}: status は ${COMPONENT_STATUS.join('・')} のどれかにしてください`)
    users.push({ where: `${file} ${data.name ?? basename(file, '.md')}`, layer: 'rule', refs: Array.isArray(data.from) ? data.from : null, retired: data.status === 'deprecated', component: { file, ...data } })
  }
  for (const t of tokens.values()) {
    if (t.tier !== 'semantic') continue
    const aliases = [t.value, t.ext.modes?.dark].map((v) => (typeof v === 'string' ? ALIAS.exec(v)?.[1] : undefined)).filter(Boolean)
    users.push({ where: `${config.tokens} ${t.path}`, layer: 'rule', refs: Array.isArray(t.from) ? t.from : null, retired: t.deprecated !== undefined, token: t.path, aliases })
  }
  return { P: P.ids, D: D.ids, users, errors }
}

export function checkTrace(trace) {
  const errors = [...trace.errors]
  const warnings = []
  const deprecated = []
  const used = new Set()
  for (const u of trace.users) {
    if (!u.refs || !u.refs.length) {
      if (!u.retired) errors.push(`trace-none: ${u.where} に根拠がありません`)
      continue
    }
    for (const ref of u.refs) {
      used.add(ref)
      const isP = /^P\d+$/.test(ref)
      const isD = /^D\d+$/.test(ref)
      const target = isP ? trace.P.get(ref) : isD ? trace.D.get(ref) : null
      if (!target) {
        errors.push(`trace-missing: ${u.where} が、実在しない ${ref} を指しています`)
        continue
      }
      if ((u.layer === 'D' && !isP) || (u.layer === 'rule' && !isD)) errors.push(`trace-layer: ${u.where} が ${ref} を指しています（${u.layer === 'D' ? 'デザインの原則は P' : 'トークン・基礎・部品・パターン・文言は D'} だけを指す）`)
      if (target.retired && !u.retired) deprecated.push(`trace-deprecated: ${u.where} が、廃止された ${ref} を使っています`)
    }
  }
  for (const [id, p] of [...trace.P, ...trace.D]) if (!p.retired && !used.has(id)) warnings.push(`trace-orphan: ${id} はどこからも使われていません`)
  return { errors, warnings, deprecated }
}

// ID かトークンの道のりから、影響を受けるものを下へたどる。
export function traceFrom(trace, start) {
  const out = []
  const seen = new Set()
  const visit = (key, depth) => {
    for (const u of trace.users) {
      const hits = u.refs?.includes(key) || (u.aliases?.includes(key) ?? false)
      if (!hits) continue
      const id = u.id ?? u.token ?? u.where
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ depth, where: u.where, ...(u.component ? { outputs: u.component.outputs ?? {} } : {}) })
      if (u.id) visit(u.id, depth + 1)
      if (u.token) visit(u.token, depth + 1)
    }
  }
  visit(start, 1)
  return out
}

// ---------------------------------------------------------------------------
// 候補

export function readCandidates(repo, config) {
  const errors = []
  const open = []
  for (const file of mdFiles(repo, config.candidates ?? 'docs/design-candidates')) {
    const { data } = parseFrontMatter(readFileSync(join(repo, file), 'utf8'))
    if (!data || !CANDIDATE_STATUS.includes(data.status)) {
      errors.push(`${file}: 先頭のメタデータの status は ${CANDIDATE_STATUS.join('・')} のどれかにしてください`)
      continue
    }
    if (!Array.isArray(data.screens) || !data.screens.length) errors.push(`${file}: screens（どの画面で必要か）の一覧がありません`)
    if (data.status === 'open') open.push({ file, screens: Array.isArray(data.screens) ? data.screens : [] })
  }
  return { errors, open }
}

// ---------------------------------------------------------------------------
// 実行

export function loadConfig(repo) {
  const file = join(repo, CONFIG_PATH)
  if (!existsSync(file)) throw new Error(`${file} がありません。先に /product-design:init を実行してください`)
  const config = JSON.parse(readFileSync(file, 'utf8'))
  if (config.version !== 2) throw new Error(`${file} の version が 2 ではありません（v1 のアプリは /product-design:update で移す）`)
  return config
}

export function runCheck(repo, { strict = false } = {}) {
  const config = loadConfig(repo)
  let root
  try {
    root = JSON.parse(readFileSync(join(repo, config.tokens), 'utf8'))
  } catch (e) {
    throw new Error(`${config.tokens} が読めません: ${e.message}`)
  }
  const dsErrors = []
  const warnings = []
  const deprecated = []
  for (const [stage, state] of Object.entries(config.stages ?? {})) {
    if (!STAGES.includes(stage) || !['pending', 'approved'].includes(state)) dsErrors.push(`${CONFIG_PATH}: stages.${stage} は ${STAGES.join('・')} の段に、pending か approved を書いてください`)
  }
  const tok = validateTokens(root, config.base)
  dsErrors.push(...tok.errors.map((e) => `tokens: ${e}`))
  deprecated.push(...tok.deprecated)
  if (!tok.errors.length) {
    const c = checkContrast(root, tok.tokens)
    dsErrors.push(...c.errors)
    warnings.push(...c.warnings)
  }
  const tr = checkTrace(collectTrace(repo, config, tok.tokens))
  dsErrors.push(...tr.errors)
  warnings.push(...tr.warnings)
  deprecated.push(...tr.deprecated)
  const cand = readCandidates(repo, config)
  dsErrors.push(...cand.errors)

  // アプリのコードのチェックは、出力（2 段階目以降）ができてから足す。
  const violations = []
  const ok = violations.length === 0 && (!strict || dsErrors.length === 0)
  return { ok, violations, ds_errors: dsErrors, warnings, stale: [], deprecated, candidates: cand.open, allowed: 0, files: 0 }
}

export function formatResult(r) {
  const out = [r.ok ? 'デザインシステムのチェック: 通った' : 'デザインシステムのチェック: 通らなかった']
  const section = (title, items) => items.length && out.push(`${title}（${items.length}）:`, ...items.map((s) => `- ${typeof s === 'string' ? s : `${s.file}:${s.line} ${s.rule} → ${s.hint}`}`))
  section('アプリのコードの違反', r.violations)
  section('デザインシステムの中の不備', r.ds_errors)
  section('廃止されたものを使っている', r.deprecated)
  section('警告', r.warnings)
  section('古くなったもの', r.stale)
  section('未決の候補', r.candidates.map((c) => `${c.file}（${c.screens.join('・')}）`))
  return out.join('\n')
}

// 写した先（design-system/check.mjs）から動かしたときは、その親をリポジトリとみなす。
function defaultRepo() {
  const here = dirname(fileURLToPath(import.meta.url))
  return existsSync(join(here, 'design-system.json')) ? resolve(here, '..') : process.cwd()
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--repo')
  const repo = at >= 0 ? resolve(args[at + 1]) : defaultRepo()
  try {
    const r = runCheck(repo, { strict: args.includes('--strict') })
    console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : formatResult(r))
    process.exitCode = r.ok ? 0 : 1
  } catch (e) {
    console.error(e.message)
    process.exitCode = 2
  }
}
