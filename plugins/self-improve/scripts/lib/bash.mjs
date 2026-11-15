// Bash のコマンド文字列の、粗い読み取り。
// 目的は 3 つ：禁止パターンの照合、「読むだけ」のコマンドの判定、書き込み先のパスの拾い出し。
// シェルを完全には再現しない。見分けられないもの（コマンド置換など）は、厳しい側に倒す。
import { basename } from 'node:path'
import { NOTE_BIN } from './core.mjs'

// ヒアドキュメントの本文を取り除く。区切りが引用されていない本文にコマンド置換があれば unsafe。
export function stripHeredocs(command) {
  const lines = String(command ?? '').split('\n')
  const out = []
  let unsafe = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    out.push(line)
    const re = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g
    let match
    while ((match = re.exec(line))) {
      if (line[match.index - 1] === '<') continue // <<< はヒアストリング
      const quoted = match[1] !== ''
      i++
      while (i < lines.length && lines[i].trim() !== match[2]) {
        if (!quoted && /\$\(|`/.test(lines[i])) unsafe = true
        i++
      }
    }
  }
  return { text: out.join('\n'), unsafe }
}

const newSegment = () => ({ words: [], redirects: [] })

// コマンドを、区切り（; && || | & 改行 括弧）ごとのセグメントに分ける。
// 各セグメントは words（引用を外した語）と redirects（op と target）を持つ。
export function parseBash(command, depth = 0) {
  const { text, unsafe } = stripHeredocs(command)
  const segments = []
  let subst = false
  let segment = newSegment()
  let word = null
  let pendingRedirect = null

  const endWord = () => {
    if (!word) return
    if (pendingRedirect) {
      segment.redirects.push({ op: pendingRedirect, target: word.text })
      pendingRedirect = null
    } else {
      segment.words.push(word)
    }
    word = null
  }
  const endSegment = () => {
    endWord()
    pendingRedirect = null
    if (segment.words.length || segment.redirects.length) segments.push(segment)
    segment = newSegment()
  }
  const add = (ch, quoted = false) => {
    if (!word) word = { text: '', quoted: false }
    word.text += ch
    if (quoted) word.quoted = true
  }

  let state = 'normal'
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (state === 'single') {
      if (ch === "'") state = 'normal'
      else add(ch, true)
      continue
    }
    if (state === 'double') {
      if (ch === '"') state = 'normal'
      else if (ch === '\\' && next !== undefined && '"\\$`\n'.includes(next)) {
        add(next, true)
        i++
      } else {
        if (ch === '`' || (ch === '$' && next === '(')) subst = true
        add(ch, true)
      }
      continue
    }
    if (ch === "'") {
      state = 'single'
      add('', true)
    } else if (ch === '"') {
      state = 'double'
      add('', true)
    } else if (ch === '\\') {
      if (next === '\n') i++
      else if (next !== undefined) {
        add(next)
        i++
      }
    } else if (ch === ' ' || ch === '\t') {
      endWord()
    } else if (ch === '#' && !word) {
      while (i < text.length && text[i] !== '\n') i++
      i--
    } else if (ch === '`') {
      subst = true
      endSegment()
    } else if (ch === '$' && next === '(') {
      subst = true
      endSegment()
      i++
    } else if (ch === '\n' || ch === ';' || ch === '(' || ch === ')') {
      endSegment()
    } else if (ch === '|') {
      endSegment()
      if (next === '|' || next === '&') i++
    } else if (ch === '&') {
      if (next === '>') {
        endWord()
        pendingRedirect = text[i + 2] === '>' ? '&>>' : '&>'
        i += pendingRedirect.length - 1
      } else {
        endSegment()
        if (next === '&') i++
      }
    } else if (ch === '>' || ch === '<') {
      if (word && /^\d+$/.test(word.text) && !word.quoted) word = null
      else endWord()
      let op = ch
      if (next === ch) {
        op += next
        i++
        if (ch === '<' && text[i + 1] === '<') {
          op += '<'
          i++
        }
      } else if (ch === '>' && (next === '&' || next === '|')) {
        op += next
        i++
      } else if (ch === '<' && next === '&') {
        op += next
        i++
      }
      pendingRedirect = op
    } else {
      add(ch)
    }
  }
  endSegment()

  // bash -c '...' と eval '...' の中身も調べる。
  let heredocUnsafe = unsafe
  if (depth < 3) {
    for (const seg of [...segments]) {
      const { name, args } = commandOf(seg)
      const base = basename(name)
      let inner = null
      if (['bash', 'sh', 'zsh', 'dash'].includes(base)) {
        const at = args.findIndex((a) => /^-[a-zA-Z]*c$/.test(a))
        if (at >= 0 && args[at + 1] !== undefined) inner = args[at + 1]
      } else if (base === 'eval') {
        inner = args.join(' ')
      }
      if (inner) {
        const parsed = parseBash(inner, depth + 1)
        segments.push(...parsed.segments)
        subst = subst || parsed.subst
        heredocUnsafe = heredocUnsafe || parsed.heredocUnsafe
      }
    }
  }
  return { segments, subst, heredocUnsafe }
}

export function commandOf(segment) {
  let i = 0
  const assigns = []
  while (i < segment.words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment.words[i].text)) assigns.push(segment.words[i++].text)
  return { assigns, name: segment.words[i]?.text ?? '', args: segment.words.slice(i + 1).map((w) => w.text) }
}

// 禁止パターンを当てる文字列。空白を含む引用（コミットメッセージなど）は伏せて、誤検知を減らす。
export function skeleton(segment) {
  return segment.words.map((w) => (w.quoted && /\s/.test(w.text) ? "'…'" : w.text)).join(' ')
}

export function writeRedirects(segment) {
  return segment.redirects.filter((r) => {
    if (r.op.startsWith('<')) return false
    if (r.target === '/dev/null') return false
    if (r.op === '>&' && /^(\d+|-)$/.test(r.target)) return false
    return true
  })
}

const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'pwd', 'echo', 'printf', 'date', 'which', 'whoami',
  'true', 'false', 'test', '[', 'stat', 'file', 'du', 'df', 'tree', 'basename', 'dirname', 'realpath', 'readlink',
  'uniq', 'cut', 'tr', 'jq', 'diff', 'cmp', 'printenv', 'type', 'uname', 'id', 'sleep', 'column', 'nl', 'less', 'more', 'cd',
])

const GIT_READ_ONLY = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'cat-file', 'grep', 'ls-tree',
  'merge-base', 'rev-list', 'reflog', 'whatchanged', 'name-rev', 'for-each-ref', 'check-ignore',
])

export function gitSubcommand(args) {
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '-C' || arg === '-c' || arg === '--git-dir' || arg === '--work-tree') i += 2
    else if (arg.startsWith('-')) i += 1
    else break
  }
  return { sub: args[i] ?? '', rest: args.slice(i + 1) }
}

function gitReadOnly(args) {
  const { sub, rest } = gitSubcommand(args)
  if (GIT_READ_ONLY.has(sub)) return true
  if (sub === 'branch') return rest.every((a) => /^(--list|-l|-a|-r|-v|-vv|--all|--remotes|--show-current|--verbose)$/.test(a))
  if (sub === 'remote') return rest.length === 0 || ['-v', 'get-url', 'show'].includes(rest[0])
  if (sub === 'tag') return rest.length === 0 || ['-l', '--list'].includes(rest[0])
  if (sub === 'stash') return ['list', 'show'].includes(rest[0])
  if (sub === 'worktree') return rest[0] === 'list'
  if (sub === 'config') return ['--get', '--get-all', '--list', '-l'].includes(rest[0])
  return false
}

export function isReadOnlySegment(segment) {
  if (writeRedirects(segment).length) return false
  const { name, args } = commandOf(segment)
  if (!name) return true
  const cmd = basename(name)
  if (cmd === 'git') return gitReadOnly(args)
  if (cmd === 'find') return !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fprint0|fls)$/.test(a))
  if (cmd === 'sed') return !args.some((a) => /^(-[a-zA-Z]*i|--in-place)/.test(a))
  if (cmd === 'sort') return !args.some((a) => /^(-[a-zA-Z]*o|--output)/.test(a))
  return READ_ONLY.has(cmd)
}

// harness-note の単純な呼び出しか。環境変数の前置き（データ領域の差し替え）とリダイレクトは認めない。
export function isHarnessNoteSegment(segment) {
  const { assigns, name } = commandOf(segment)
  if (assigns.length) return false
  if (name !== 'harness-note' && name !== NOTE_BIN) return false
  return writeRedirects(segment).length === 0
}

export function isHarnessNoteOnly(command) {
  const parsed = parseBash(command)
  if (parsed.subst || parsed.heredocUnsafe || parsed.segments.length === 0) return false
  return parsed.segments.every(isHarnessNoteSegment)
}

// 「変更あり」に数えないコマンドか（読むだけのコマンドと harness-note だけでできている）。
// 自動改善のセッションで通すコマンドの判定にも使う。
export function isNonChanging(command) {
  const parsed = parseBash(command)
  if (parsed.subst || parsed.heredocUnsafe) return false
  return parsed.segments.every((s) => isReadOnlySegment(s) || isHarnessNoteSegment(s))
}

const WRITERS = new Set(['tee', 'mv', 'rm', 'rmdir', 'unlink', 'shred', 'install', 'ln', 'truncate', 'touch', 'chmod', 'chown', 'rsync', 'patch'])
const GIT_WORKTREE_WRITE = new Set(['checkout', 'restore', 'rm', 'mv', 'clean', 'apply', 'stash'])
const WRAPPERS = new Set(['sudo', 'command', 'time', 'nohup', 'exec'])

// コマンドが書き換える（消す・動かすを含む）ファイルの候補を返す。
// 見るのは、リダイレクト先と、書き換えると分かっているコマンド（sed -i、tee、cp、mv、rm、git checkout など）の引数だけ。
// スクリプトの中からの書き込み（python や node など）は見分けられない。
// 返すのは、順に並んだ { command, tokens } と、cd による移動 { cd }。
export function writeTargets(command) {
  const parsed = parseBash(command)
  const out = []
  for (const segment of parsed.segments) {
    if (isHarnessNoteSegment(segment)) continue
    const tokens = writeRedirects(segment).map((r) => r.target)
    let { name, args } = commandOf(segment)
    while (WRAPPERS.has(basename(name)) && args.length) {
      const at = args.findIndex((a) => !a.startsWith('-'))
      if (at < 0) break
      name = args[at]
      args = args.slice(at + 1)
    }
    const cmd = basename(name)
    const plain = args.filter((a) => a && !a.startsWith('-'))
    // cd のあとの相対パスを正しく読むために、移動先も順に返す。
    if (cmd === 'cd' && plain[0]) out.push({ cd: plain[0], tokens: [] })
    if (WRITERS.has(cmd)) tokens.push(...plain)
    else if (cmd === 'cp') tokens.push(...plain.slice(-1))
    else if (cmd === 'dd') tokens.push(...args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)))
    else if (cmd === 'sed' && args.some((a) => /^(-[a-zA-Z]*i|--in-place)/.test(a))) tokens.push(...plain)
    else if (cmd === 'perl' && args.some((a) => /^-[a-zA-Z]*i/.test(a))) tokens.push(...plain)
    else if (cmd === 'git') {
      const { sub, rest } = gitSubcommand(args)
      if (GIT_WORKTREE_WRITE.has(sub)) tokens.push(...rest.filter((a) => a && !a.startsWith('-')))
    }
    if (tokens.length) out.push({ command: skeleton(segment), tokens })
  }
  return out
}
