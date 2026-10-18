// デザインシステムのチェック。design-system プラグインから、アプリのリポジトリの design-system/check.mjs に写して使う。
// 手で直さない（/design-system:init と /design-system:update がプラグインの版で上書きする）。
// Node の標準機能だけで動き、このファイルだけで完結する。
//
//   node design-system/check.mjs [--json] [--repo <path>]
//
// 調べること:
//   - tokens.json の値が正しく、<code>/Tokens.swift が tokens.json から作ったものと同じか
//   - デザインシステムのフォルダとテストを除いた Swift コードに、直書きの色・文字・余白と角丸、部品を通さないボタンや入力欄がないか
//   - Artifact に写した中身が古くなっていないか（古くても失敗にはしない）
// 違反があれば終了コード 1。
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CONFIG_PATH = 'design-system/design-system.json'

// ひな形の部品が使う役割。これがないと部品がビルドできない。
export const REQUIRED = {
  color: ['background', 'surface', 'text-primary', 'text-secondary', 'text-on-accent', 'accent', 'border', 'danger', 'warning', 'success', 'info'],
  type: ['title', 'headline', 'body', 'callout', 'caption'],
  spacing: ['space-1', 'space-2', 'space-3', 'space-4', 'space-5', 'space-6'],
  radius: ['radius-sm', 'radius-md', 'radius-lg'],
}

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

// tokens.json の textStyle → [UIFont.TextStyle, SwiftUI の Font.TextStyle]
const TEXT_STYLES = {
  largeTitle: ['largeTitle', 'largeTitle'],
  title: ['title1', 'title'],
  title2: ['title2', 'title2'],
  title3: ['title3', 'title3'],
  headline: ['headline', 'headline'],
  subheadline: ['subheadline', 'subheadline'],
  body: ['body', 'body'],
  callout: ['callout', 'callout'],
  footnote: ['footnote', 'footnote'],
  caption: ['caption1', 'caption'],
  caption2: ['caption2', 'caption2'],
}

const WEIGHTS = { 100: 'ultraLight', 200: 'thin', 300: 'light', 400: 'regular', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'heavy', 900: 'black' }

const SYSTEM_FAMILIES = ['system-ui', '-apple-system', 'sans-serif', 'ui-sans-serif', 'BlinkMacSystemFont']

export function swiftName(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
}

export function parseColor(value) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(typeof value === 'string' ? value.trim() : '')
  if (!m) return null
  let hex = m[1]
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('')
  if (hex.length === 6) hex += 'ff'
  return [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
}

function parseLength(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const m = /^(\d+(?:\.\d+)?)px$/.exec(typeof value === 'string' ? value.trim() : '')
  return m ? Number(m[1]) : null
}

// 色の値をテーマごとに読む。文字列なら最初のテーマ（light）の値で、ないテーマは light を引き継ぐ。
function colorValues(token) {
  const v = typeof token.value === 'string' ? { light: token.value } : token.value ?? {}
  const light = parseColor(v.light)
  const dark = v.dark === undefined ? light : parseColor(v.dark)
  return { light, dark }
}

function list(family) {
  return Array.isArray(family?.tokens) ? family.tokens : null
}

function styles(tokens) {
  return (tokens.type?.groups ?? []).flatMap((g) => (g.styles ?? []).map((s) => ({ ...s, family: g.family })))
}

export function validateTokens(tokens) {
  const errors = []
  if (!tokens || typeof tokens !== 'object') return ['tokens.json が JSON のオブジェクトではありません']
  for (const family of ['color', 'spacing', 'radius']) if (!list(tokens[family])) errors.push(`${family}.tokens が配列ではありません`)
  if (!Array.isArray(tokens.type?.groups)) errors.push('type.groups が配列ではありません')
  if (errors.length) return errors

  if (!(tokens.color.themes ?? []).some((t) => t.id === 'light')) errors.push('color.themes に light のテーマがありません')

  const seen = new Map()
  const named = (token, family) => {
    const name = token?.name
    if (typeof name !== 'string' || !NAME.test(name)) {
      errors.push(`"${name}"（${family}）の名前は小文字の kebab-case にしてください（例 text-primary）`)
      return false
    }
    const key = swiftName(name)
    if (seen.has(key)) errors.push(`"${name}" が重複しています（${seen.get(key)} と ${family}）`)
    seen.set(key, family)
    return true
  }

  for (const t of tokens.color.tokens) {
    if (!named(t, 'color')) continue
    const { light, dark } = colorValues(t)
    if (!light || !dark) errors.push(`"${t.name}" の色の値が読めません（#rgb / #rrggbb / #rrggbbaa で、light は必須）`)
  }
  const families = tokens.type.families ?? {}
  for (const s of styles(tokens)) {
    if (!named(s, 'type')) continue
    if (!families[s.family]) errors.push(`"${s.name}" の family "${s.family}" が type.families にありません`)
    if (parseLength(s.fontSize) === null) errors.push(`"${s.name}" の fontSize は px か数値にしてください`)
    if (!WEIGHTS[s.fontWeight ?? 400]) errors.push(`"${s.name}" の fontWeight は 100〜900 の 100 刻みにしてください`)
    if (!TEXT_STYLES[s.textStyle ?? 'body']) errors.push(`"${s.name}" の textStyle は ${Object.keys(TEXT_STYLES).join(' / ')} のどれかにしてください`)
  }
  for (const family of ['spacing', 'radius']) {
    for (const t of tokens[family].tokens) {
      if (!named(t, family)) continue
      if (parseLength(t.value) === null) errors.push(`"${t.name}" の値は px か数値にしてください`)
    }
  }

  const names = {
    color: tokens.color.tokens.map((t) => t.name),
    type: styles(tokens).map((s) => s.name),
    spacing: tokens.spacing.tokens.map((t) => t.name),
    radius: tokens.radius.tokens.map((t) => t.name),
  }
  for (const [family, required] of Object.entries(REQUIRED)) {
    for (const name of required) if (!names[family].includes(name)) errors.push(`必ずある役割 "${name}"（${family}）がありません`)
  }
  return errors
}

const num = (x) => String(Number(x.toFixed(4)))
const rgba = (c) => `(${c.map(num).join(', ')})`
const doc = (text, indent) => (text ? `${indent}/// ${String(text).replace(/\s*\n\s*/g, ' ')}\n` : '')

function fontExpr(s, families) {
  const size = num(parseLength(s.fontSize))
  const [uiStyle, swiftStyle] = TEXT_STYLES[s.textStyle ?? 'body']
  const first = (families[s.family] ?? '').split(',')[0].trim().replace(/^["']|["']$/g, '')
  if (first && !SYSTEM_FAMILIES.includes(first)) return `.custom(${JSON.stringify(first)}, size: ${size}, relativeTo: .${swiftStyle})`
  return `scaled(${size}, .${WEIGHTS[s.fontWeight ?? 400]}, .${uiStyle})`
}

// tokens.json から Tokens.swift を作る。同じ入力からは同じ出力になる。
const swiftString = (text) => `"${String(text ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`

// カタログ画面がトークンの一覧を出せるように、名前・値・使いどころの組を並べる。
function catalog(entries, field, type, computed) {
  const rows = entries.map((t) => `(${swiftString(t.name)}, ${swiftName(t.name)}, ${swiftString(t.usage)}),`)
  const head = `static ${computed ? 'var' : 'let'} all: [(name: String, ${field}: ${type}, usage: String)]`
  if (computed) return [`        ${head} {`, '            [', ...rows.map((r) => `                ${r}`), '            ]', '        }'].join('\n')
  return [`        ${head} = [`, ...rows.map((r) => `            ${r}`), '        ]'].join('\n')
}

// tokens.json から Tokens.swift を作る。同じ入力からは同じ出力になる。
export function generateSwift(tokens) {
  const i2 = '        '
  const colors = tokens.color.tokens
    .map((t) => {
      const { light, dark } = colorValues(t)
      return `${doc(t.usage, i2)}${i2}static let ${swiftName(t.name)} = dynamic(light: ${rgba(light)}, dark: ${rgba(dark)})`
    })
    .join('\n')
  const families = tokens.type.families ?? {}
  const fontStyles = styles(tokens)
  const fonts = fontStyles
    .map((s) => {
      const note = [s.usage, `${num(parseLength(s.fontSize))}${s.lineHeight ? `/${num(parseLength(s.lineHeight) ?? 0)}` : ''}`].filter(Boolean).join('（') + (s.usage ? '）' : '')
      return `${doc(note, i2)}${i2}static var ${swiftName(s.name)}: SwiftUI.Font { ${fontExpr(s, families)} }`
    })
    .join('\n')
  const lengths = (family) =>
    [
      ...tokens[family].tokens.map((t) => `${doc(t.usage, i2)}${i2}static let ${swiftName(t.name)}: CGFloat = ${num(parseLength(t.value))}`),
      '',
      catalog(tokens[family].tokens, 'value', 'CGFloat', false),
    ].join('\n')

  return `// tokens.json から生成（手で直さない）。値を変えるときは /design-system:update を使う。
import SwiftUI
import UIKit

enum DS {
    enum Color {
${colors}

${catalog(tokens.color.tokens, 'color', 'SwiftUI.Color', false)}
    }

    enum Font {
${fonts}

${catalog(fontStyles, 'font', 'SwiftUI.Font', true)}
    }

    enum Space {
${lengths('spacing')}
    }

    enum Radius {
${lengths('radius')}
    }
}

extension DS.Color {
    typealias RGBA = (Double, Double, Double, Double)

    /// ライトとダークで値を切り替える色。
    static func dynamic(light: RGBA, dark: RGBA) -> SwiftUI.Color {
        SwiftUI.Color(UIColor { traits in
            let c = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: c.0, green: c.1, blue: c.2, alpha: c.3)
        })
    }
}

extension DS.Font {
    /// 文字の大きさの設定（Dynamic Type）に合わせて大きくなるシステムの文字。
    static func scaled(_ size: CGFloat, _ weight: SwiftUI.Font.Weight, _ style: UIFont.TextStyle) -> SwiftUI.Font {
        .system(size: UIFontMetrics(forTextStyle: style).scaledValue(for: size), weight: weight)
    }
}
`
}

// コメントと文字列の中身を空白にする（行の数は変えない）。決まりはコードの部分だけに当てる。
export function stripCode(src) {
  const blank = (s) => s.replace(/[^\n]/g, ' ')
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      const j = src.indexOf('\n', i)
      const end = j === -1 ? n : j
      out += blank(src.slice(i, end))
      i = end
      continue
    }
    if (c === '/' && d === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth) {
        if (src[j] === '/' && src[j + 1] === '*') (depth++, (j += 2))
        else if (src[j] === '*' && src[j + 1] === '/') (depth--, (j += 2))
        else j++
      }
      out += blank(src.slice(i, j))
      i = j
      continue
    }
    const raw = /^#+"/.exec(src.slice(i, i + 8))
    if (c === '"' || raw) {
      const hashes = raw ? raw[0].length - 1 : 0
      const q = i + hashes
      const multi = src.startsWith('"""', q)
      const open = multi ? '"""' : '"'
      const close = open + '#'.repeat(hashes)
      let k = q + open.length
      while (k < n) {
        if (hashes === 0 && src[k] === '\\') {
          if (src[k + 1] === '(') {
            // 文字列の中の式 \( … ) は、対応する ) まで飛ばす
            let depth = 1
            k += 2
            while (k < n && depth) {
              if (src[k] === '(') depth++
              else if (src[k] === ')') depth--
              k++
            }
          } else k += 2
          continue
        }
        if (src.startsWith(close, k)) break
        if (!multi && src[k] === '\n') break
        k++
      }
      const bodyEnd = Math.min(k, n)
      const end = src.startsWith(close, k) ? k + close.length : bodyEnd
      out += src.slice(i, q + open.length) + blank(src.slice(q + open.length, bodyEnd)) + src.slice(bodyEnd, end)
      i = end
      continue
    }
    out += c
    i++
  }
  return out
}

// 0 だけは「余白なし」として許す
const NUM = '(?!0(?:\\.0+)?(?![\\d.]))\\d+(?:\\.\\d+)?'
const COLOR_NAMES = 'red|orange|yellow|green|mint|teal|cyan|blue|indigo|purple|pink|brown|white|gray|black|primary|secondary|tertiary|quaternary|quinary|accentColor'
const CONTROLS = 'Button|TextField|SecureField|TextEditor|Toggle|Picker'

export const RULES = [
  {
    rule: 'color',
    hint: 'DS.Color.* を使う',
    patterns: [
      new RegExp(`\\.(?:foregroundStyle|foregroundColor|background|tint|fill|stroke|border|listRowBackground|overlay|accentColor|shadow)\\s*\\(\\s*\\.(?:${COLOR_NAMES})\\b`, 'g'),
      /(?<![\w.])Color\s*\.\s*(?!clear\b)[A-Za-z_]\w*/g,
      /(?<![\w.])Color\s*\(/g,
      /\b(?:UI|NS)Color\b/g,
      /#colorLiteral\b/g,
    ],
  },
  {
    rule: 'font',
    hint: 'DS.Font.* を使う',
    patterns: [/\.font\s*\((?!\s*DS\.Font\.)\s*[\w.]*/g, /\.(?:fontWeight|fontDesign|fontWidth)\s*\(/g, /\.(?:bold|italic)\s*\(\s*\)/g, /(?<![\w.])Font\s*\./g, /\b(?:UI|NS)Font\b/g],
  },
  {
    rule: 'spacing',
    hint: 'DS.Space.* と DS.Radius.* を使う',
    patterns: [
      new RegExp(`\\.padding\\s*\\((?:[^()]*,)?\\s*${NUM}\\s*\\)`, 'g'),
      new RegExp(`\\bspacing\\s*:\\s*${NUM}`, 'g'),
      new RegExp(`cornerRadius\\s*(?::|\\()\\s*${NUM}`, 'g'),
      new RegExp(`EdgeInsets\\s*\\([^)]*?${NUM}`, 'g'),
      new RegExp(`\\.lineSpacing\\s*\\(\\s*${NUM}`, 'g'),
    ],
  },
  {
    rule: 'control',
    hint: 'DSButton・DSTextField などの部品を使う（design-system/components.md）',
    patterns: [new RegExp(`(?<![\\w.])(?:${CONTROLS})\\s*[({]`, 'g'), new RegExp(`\\bSwiftUI\\.(?:${CONTROLS})\\b`, 'g')],
  },
]

const ALLOW = /design-system:\s*allow\s+([a-z]+)/g

function allowedRules(line) {
  return [...(line ?? '').matchAll(ALLOW)].map((m) => m[1])
}

export function checkSource(src, file = '') {
  const lines = src.split('\n')
  const code = stripCode(src).split('\n')
  const violations = []
  let allowed = 0
  code.forEach((text, idx) => {
    // 直前の行は、コメントだけの行のときに効く（行末のコメントは、その行だけに効く）
    const prev = /^\s*\/\//.test(lines[idx - 1] ?? '') ? lines[idx - 1] : ''
    const allow = [...allowedRules(lines[idx]), ...allowedRules(prev)]
    for (const { rule, hint, patterns } of RULES) {
      for (const re of patterns) {
        for (const m of text.matchAll(re)) {
          if (allow.includes(rule)) allowed++
          else violations.push({ file, line: idx + 1, rule, text: m[0].trim(), hint })
        }
      }
    }
  })
  return { violations, allowed }
}

const posix = (p) => p.split(sep).join('/')

function isTest(path) {
  return path.split('/').some((part, i, all) => (i < all.length - 1 ? /Tests$/.test(part) : /Tests\.swift$/.test(part)))
}

function swiftFiles(repo, dir) {
  const abs = join(repo, dir)
  if (!existsSync(abs)) return []
  if (statSync(abs).isFile()) return abs.endsWith('.swift') ? [posix(relative(repo, abs))] : []
  return readdirSync(abs, { recursive: true })
    .map((p) => posix(join(dir, String(p))))
    .filter((p) => p.endsWith('.swift') && statSync(join(repo, p)).isFile())
}

export function loadConfig(repo) {
  const file = join(repo, CONFIG_PATH)
  if (!existsSync(file)) throw new Error(`${file} がありません。先に /design-system:init を実行してください`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

function screenshotFiles(repo) {
  const dir = join(repo, dirname(CONFIG_PATH), 'screenshots')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith('.png'))
    .sort()
    .map((n) => posix(join(dirname(CONFIG_PATH), 'screenshots', n)))
}

// Artifact に写す中身（トークン・文書・スクリーンショット）のハッシュ。設定ファイル自身は含めない。
export function artifactHash(repo, config) {
  const h = createHash('sha256')
  for (const p of [config.tokens, ...(config.docs ?? []), ...screenshotFiles(repo)]) {
    h.update(`${p}\0`)
    const abs = join(repo, p)
    h.update(existsSync(abs) ? readFileSync(abs) : 'missing')
    h.update('\0')
  }
  return h.digest('hex')
}

export function runCheck(repo) {
  const config = loadConfig(repo)
  const violations = []
  const stale = []
  let allowed = 0
  const code = config.ios?.code
  const tokensFile = join(repo, config.tokens)

  let tokens = null
  try {
    tokens = JSON.parse(readFileSync(tokensFile, 'utf8'))
  } catch (e) {
    violations.push({ file: config.tokens, line: 1, rule: 'tokens', text: '', hint: `読めません: ${e.message}` })
  }
  if (tokens) {
    const errors = validateTokens(tokens)
    for (const e of errors) violations.push({ file: config.tokens, line: 1, rule: 'tokens', text: '', hint: e })
    if (!errors.length && code) {
      const swiftFile = posix(join(code, 'Tokens.swift'))
      const current = existsSync(join(repo, swiftFile)) ? readFileSync(join(repo, swiftFile), 'utf8') : null
      if (current !== generateSwift(tokens)) violations.push({ file: swiftFile, line: 1, rule: 'tokens', text: '', hint: 'Tokens.swift が tokens.json から作ったものと違います（/design-system:update で作り直す）' })
    }
  }

  const exclude = [code, ...(config.check?.exclude ?? [])].filter(Boolean).map((p) => p.replace(/\/+$/, '') + '/')
  const files = [...new Set((config.ios?.sources ?? []).flatMap((dir) => swiftFiles(repo, dir)))]
    .filter((p) => !exclude.some((e) => p.startsWith(e)) && !isTest(p))
    .sort()
  for (const file of files) {
    const r = checkSource(readFileSync(join(repo, file), 'utf8'), file)
    violations.push(...r.violations)
    allowed += r.allowed
  }

  if (config.artifact?.hash && artifactHash(repo, config) !== config.artifact.hash) {
    stale.push(`Artifact（${config.artifact.url}）に写した中身が古くなっています（/design-system:update で写し直す）`)
  }
  return { ok: violations.length === 0, violations, stale, allowed, files: files.length }
}

export function formatResult(r) {
  const out = [r.ok ? `デザインシステムのチェック: 違反なし（${r.files} ファイル）` : `デザインシステムのチェック: 違反 ${r.violations.length} 件（${r.files} ファイル）`]
  for (const v of r.violations) out.push(`${v.file}:${v.line} ${v.rule} ${v.text ? `${v.text} ` : ''}→ ${v.hint}`)
  if (r.stale.length) out.push('古くなったもの:', ...r.stale.map((s) => `- ${s}`))
  if (r.allowed) out.push(`allow のコメントで通した箇所: ${r.allowed}`)
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
    const r = runCheck(repo)
    console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : formatResult(r))
    process.exitCode = r.ok ? 0 : 1
  } catch (e) {
    console.error(e.message)
    process.exitCode = 2
  }
}
