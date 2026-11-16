// Bash のコマンド文字列の、粗い読み取り。
// 目的は 3 つ：禁止パターンの照合、「読むだけ」のコマンドの判定、書き込み先のパスの拾い出し。
// シェルを完全には再現しない。読み取りに自信のない書き方（uncertain）と、コマンド置換（subst）は印を付け、
// 呼び出し側が厳しい側に倒す。
import { basename } from 'node:path'
import { NOTE_BIN } from './core.mjs'

const newSegment = () => ({ words: [], redirects: [] })
const SIMPLE_DELIMITER = /^[A-Za-z0-9_]+$/
const SIMPLE_PARAMETER = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}/
// 引用の外にあると、bash が語を作り替える文字（ブレース展開、パス名展開、チルダ展開）。
const SPECIAL_CHARS = '{}*?[]~'

// コマンドを、区切り（; && || | & 改行 括弧）ごとのセグメントに分ける。
// 各セグメントは words（引用を外した語）と redirects（op と target）を持つ。
// 語とリダイレクト先には、次の印が付く。
//   quoted   引用（'…'、"…"）を含む
//   expands  変数の展開やコマンド置換を含む（$NAME、${NAME}、"…$NAME…"、`…`）
//   special  引用の外に、bash が語を作り替える文字（{ } * ? [ ] ~）がある。ブレース展開・パス名展開・チルダ展開で、
//            1 つの語が別の語や複数の語になりうる（{--session=x,--key} は 2 語になる）
// 返す印：
//   subst      コマンド置換（$( ) とバッククォート）がある
//   uncertain  bash と読み方がずれうる書き方がある。$'…'、${…@…} のような単純でない展開、
//              区切りが単純でないヒアドキュメント、終わりの見つからないヒアドキュメントや引用、
//              区切りを引用していないヒアドキュメントの本文の展開
export function parseBash(command, depth = 0) {
  const text = String(command ?? '')
  const segments = []
  let subst = false
  let uncertain = false
  let segment = newSegment()
  let word = null
  let pendingRedirect = null
  const heredocs = []

  const endWord = () => {
    if (!word) return
    if (pendingRedirect) {
      segment.redirects.push({ op: pendingRedirect, target: word.text, quoted: word.quoted, expands: word.expands, special: word.special })
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
    if (!word) word = { text: '', quoted: false, expands: false, special: false }
    word.text += ch
    if (quoted) word.quoted = true
  }
  // $ で始まる展開。単純な $NAME と ${NAME} 以外は、読み方に自信がないものとして扱う。
  const expansion = (at) => {
    const next = text[at + 1]
    if (next === '(') subst = true
    else if (next === '{' && !SIMPLE_PARAMETER.test(text.slice(at, at + 80))) uncertain = true
    if (word) word.expands = true
  }

  // ヒアドキュメントの区切りの語を読む。start は <<（または <<-）の直後。
  const readDelimiter = (start) => {
    let at = start
    while (text[at] === ' ' || text[at] === '\t') at++
    let tag = ''
    let quoted = false
    for (; at < text.length; at++) {
      const ch = text[at]
      if (ch === "'" || ch === '"') {
        const end = text.indexOf(ch, at + 1)
        if (end < 0) {
          uncertain = true
          return { tag, quoted: true, next: text.length }
        }
        tag += text.slice(at + 1, end)
        quoted = true
        at = end
      } else if (ch === '\\' && text[at + 1] !== undefined) {
        tag += text[at + 1]
        quoted = true
        at++
      } else if (/[\s;&|<>()]/.test(ch)) {
        break
      } else {
        tag += ch
      }
    }
    if (!SIMPLE_DELIMITER.test(tag)) uncertain = true
    return { tag, quoted, next: at }
  }
  // 行の終わりで、たまっているヒアドキュメントの本文を読み飛ばす。start は改行の次の位置。
  const skipHeredocs = (start) => {
    let at = start
    for (const doc of heredocs.splice(0)) {
      let found = false
      while (at <= text.length) {
        let end = text.indexOf('\n', at)
        if (end < 0) end = text.length
        const line = text.slice(at, end)
        at = end + 1
        if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.tag) {
          found = true
          break
        }
        if (!doc.quoted && /[$`]/.test(line)) uncertain = true
        if (end === text.length) break
      }
      if (!found) uncertain = true
    }
    return at
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
        add(ch, true)
        if (ch === '`') {
          subst = true
          word.expands = true
        } else if (ch === '$') {
          expansion(i)
        }
      }
      continue
    }
    if (ch === "'") {
      state = 'single'
      add('', true)
    } else if (ch === '"') {
      state = 'double'
      add('', true)
    } else if (ch === '$' && next === "'") {
      // $'…' は \' を含められる。中身を取り違えないよう、ここで終わりまで読む。
      uncertain = true
      add('', true)
      let j = i + 2
      for (; j < text.length && text[j] !== "'"; j++) {
        if (text[j] === '\\' && j + 1 < text.length) j++
        add(text[j], true)
      }
      if (j >= text.length) uncertain = true
      i = j
    } else if (ch === '$' && next === '"') {
      // $"…" は、二重引用と同じに読む（$ を読み飛ばすだけ）。
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
    } else if (ch === '$') {
      add(ch)
      expansion(i)
    } else if (ch === '\n') {
      endSegment()
      if (heredocs.length) i = skipHeredocs(i + 1) - 1
    } else if (ch === ';' || ch === '(' || ch === ')') {
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
    } else if (ch === '<' && next === '<' && text[i + 2] !== '<') {
      // ヒアドキュメント。区切りの語を読み、本文は行の終わりで読み飛ばす。
      if (word && /^\d+$/.test(word.text) && !word.quoted) word = null
      else endWord()
      const stripTabs = text[i + 2] === '-'
      const doc = readDelimiter(i + (stripTabs ? 3 : 2))
      heredocs.push({ tag: doc.tag, quoted: doc.quoted, stripTabs })
      i = doc.next - 1
    } else if (ch === '>' || ch === '<') {
      if (word && /^\d+$/.test(word.text) && !word.quoted) word = null
      else endWord()
      let op = ch
      if (ch === '<' && next === '<') {
        op = '<<<'
        i += 2
      } else if (next === ch) {
        op += next
        i++
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
      if (SPECIAL_CHARS.includes(ch)) word.special = true
    }
  }
  if (state !== 'normal') uncertain = true
  endSegment()
  // 本文の始まる改行がないまま終わったヒアドキュメント。
  if (heredocs.length) uncertain = true

  // bash -c '...' と eval '...' の中身も調べる。
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
        uncertain = uncertain || parsed.uncertain
      }
    }
  }
  return { segments, subst, uncertain }
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

// 「変更あり」に数えないための、読むだけと分かっているコマンド。
// 引数しだいで書けるもの（sed、uniq、sort、find、less、rg、tree、test、printf など）は入れない。
const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'pwd', 'echo', 'date', 'which', 'whoami',
  'true', 'false', 'stat', 'file', 'du', 'df', 'basename', 'dirname', 'realpath', 'readlink',
  'cut', 'tr', 'jq', 'diff', 'cmp', 'printenv', 'type', 'uname', 'id', 'sleep', 'column', 'nl', 'cd',
])

const GIT_READ_ONLY = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'cat-file', 'ls-tree',
  'merge-base', 'rev-list', 'name-rev', 'for-each-ref', 'check-ignore',
])

export function gitSubcommand(args) {
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '-C' || arg === '-c' || arg === '--git-dir' || arg === '--work-tree') i += 2
    else if (arg.startsWith('-')) i += 1
    else break
  }
  return { sub: args[i] ?? '', rest: args.slice(i + 1), globals: args.slice(0, i) }
}

function gitReadOnly(args) {
  const { sub, rest, globals } = gitSubcommand(args)
  // -c は設定を差し替えて任意のコマンドを動かせる。--output は読み取り系でもファイルに書く。
  if (globals.some((a) => a === '-c' || a.startsWith('--exec-path') || a.startsWith('--config-env'))) return false
  if (rest.some((a) => a.startsWith('--output') || a === '-O' || a.startsWith('--ext-diff') || a.startsWith('--textconv'))) return false
  if (GIT_READ_ONLY.has(sub)) return true
  if (sub === 'branch') return rest.every((a) => /^(--list|-l|-a|-r|-v|-vv|--all|--remotes|--show-current|--verbose)$/.test(a))
  if (sub === 'remote') return rest.length === 0 || (rest.length === 1 && rest[0] === '-v') || ['get-url', 'show'].includes(rest[0])
  if (sub === 'tag') return rest.length === 0 || (rest.length === 1 && ['-l', '--list'].includes(rest[0]))
  if (sub === 'stash') return rest.length === 1 && rest[0] === 'list'
  if (sub === 'worktree') return rest.length === 1 && rest[0] === 'list'
  if (sub === 'config') return ['--get', '--get-all', '--list', '-l'].includes(rest[0])
  return false
}

export function isReadOnlySegment(segment) {
  if (writeRedirects(segment).length) return false
  const { assigns, name, args } = commandOf(segment)
  // 環境変数の前置き（GIT_EXTERNAL_DIFF など）や、代入だけの行は、読むだけとは見なさない。
  if (assigns.length) return false
  if (!name) return true
  const cmd = basename(name)
  if (cmd === 'git') return gitReadOnly(args)
  return READ_ONLY.has(cmd)
}

// harness-note の呼び出しか（前置きやリダイレクトの有無は問わない）。
export function isHarnessNoteCommand(segment) {
  const { name } = commandOf(segment)
  return name === 'harness-note' || name === NOTE_BIN
}

// harness-note の単純な呼び出しか。環境変数の前置き（データ領域の差し替え）とリダイレクトは認めない。
export function isHarnessNoteSegment(segment) {
  const { assigns } = commandOf(segment)
  if (assigns.length) return false
  if (!isHarnessNoteCommand(segment)) return false
  return segment.redirects.every((r) => r.op === '<<<' || r.target === '/dev/null')
}

// ほかのコマンドで包んだ harness-note の呼び出しか（command harness-note …、env X=1 harness-note …、
// node <プラグイン>/scripts/note.mjs …、bash <プラグイン>/bin/harness-note … など）。
// 包むと、ガードは引数（--session）を確かめられず、許可ルール Bash(harness-note *) にも当たらない。
// 見るのは、コマンドを実行する側のコマンドだけ（cat や git add のように、ファイルとして触るだけのものは見ない）。
const RUNNERS = new Set([
  'command', 'builtin', 'env', 'exec', 'nohup', 'time', 'sudo', 'nice', 'timeout', 'setsid', 'stdbuf', 'xargs', 'watch',
  'node', 'nodejs', 'bun', 'deno', 'npx', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'source', '.',
])
const NOTE_SCRIPT = /(?:^|\/)scripts\/note\.mjs$/
// isNoteScript は、scripts/note.mjs で終わるパスが、このプラグインのスクリプトかどうかを確かめる関数
// （ガードが、隣に bin/harness-note があるかで確かめる。渡さなければ、すべて当たりと見なす）。
export function isWrappedHarnessNote(segment, isNoteScript = () => true) {
  if (isHarnessNoteCommand(segment)) return false
  const { name, args } = commandOf(segment)
  // 別の場所の harness-note や、スクリプトを直接実行する形（./bin/harness-note、…/scripts/note.mjs）も、直接の呼び出しとは見なさない。
  // 名前だけ（harness-note）か、このプラグインの bin/harness-note で呼ばれたものだけを、引数まで確かめて通す。
  if (basename(name) === 'harness-note' || (NOTE_SCRIPT.test(name) && isNoteScript(name))) return true
  if (!RUNNERS.has(basename(name))) return false
  // command -v harness-note（あるかどうかを確かめるだけ）は通す。
  if (basename(name) === 'command' && /^-[vV]$/.test(args[0] ?? '')) return false
  return args.some((a) => basename(a) === 'harness-note' || (NOTE_SCRIPT.test(a) && isNoteScript(a)))
}

export function isHarnessNoteOnly(command) {
  const parsed = parseBash(command)
  if (parsed.subst || parsed.uncertain || parsed.segments.length === 0) return false
  return parsed.segments.every(isHarnessNoteSegment)
}

// 「変更あり」に数えないコマンドか（読むだけのコマンドと harness-note だけでできている）。
export function isNonChanging(command) {
  const parsed = parseBash(command)
  if (parsed.subst || parsed.uncertain) return false
  return parsed.segments.every((s) => isReadOnlySegment(s) || isHarnessNoteSegment(s))
}

const WRITERS = new Set(['tee', 'mv', 'rm', 'rmdir', 'unlink', 'shred', 'install', 'ln', 'truncate', 'touch', 'rsync', 'patch'])
const GIT_WORKTREE_WRITE = new Set(['checkout', 'restore', 'rm', 'mv', 'clean', 'apply', 'stash'])
const WRAPPERS = new Set(['sudo', 'command', 'time', 'nohup', 'exec'])

// コマンドが書き換える（消す・動かすを含む）ファイルの候補を返す。
// 見るのは、リダイレクト先と、書き換えると分かっているコマンド（sed -i、tee、cp、mv、rm、git checkout など）の引数だけ。
// スクリプトの中からの書き込み（python や node など）は見分けられない。chmod のように中身を変えないものは見ない。
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
