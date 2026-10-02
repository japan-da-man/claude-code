// Blast Radius: 危険なシェルコマンドを実行前に捕まえ、何に影響するかをサイドペインに出して確認する
const PANE = 'blast-radius'
const HISTORY_SIZE = 5
const MAX_LINES = 12
const MAX_WALK = 5000

// 直近に捕まえたコマンド。先頭が最新
// { command, impacts: [{ title, severity, summary, lines }], status: 'pending' | 'allowed' | 'blocked' }
let catches = []

// --- コマンドの解析（純粋関数。テストから直接呼ぶ） ---

// クォートを考慮してトークンに分け、; && || | 改行 で区切ったセグメントの配列を返す
export function segments(command) {
  const result = []
  let tokens = []
  let cur = ''
  let quote = null
  let hasCur = false
  const pushToken = () => {
    if (hasCur) tokens.push(cur)
    cur = ''
    hasCur = false
  }
  const pushSegment = () => {
    pushToken()
    if (tokens.length) result.push(tokens)
    tokens = []
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i]
      else cur += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      hasCur = true
    } else if (c === '\\' && i + 1 < command.length) {
      cur += command[++i]
      hasCur = true
    } else if (c === ' ' || c === '\t') {
      pushToken()
    } else if (c === ';' || c === '\n' || c === '|' || c === '&') {
      pushSegment()
      if ((c === '|' || c === '&') && command[i + 1] === c) i++
    } else {
      cur += c
      hasCur = true
    }
  }
  pushSegment()
  return result
}

// sudo / env / VAR=x などの前置きを外す
function stripPrefix(tokens) {
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (t === 'sudo' || t === 'command' || t === 'exec' || t === 'nohup' || t === 'time') i++
    else if (t === 'env') i++
    else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) i++
    else break
  }
  return tokens.slice(i)
}

const isFlag = (t) => t.startsWith('-') && t !== '-'
const shortFlags = (tokens) => tokens.filter((t) => /^-[A-Za-z]+$/.test(t)).join('')

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir'])
// 引数を1つとる find のオプションと、ファイルに書き出す find の動作（下見では外す）
const FIND_GLOBAL_OPTS = new Set(['-maxdepth', '-mindepth'])
const FIND_GLOBAL_FLAGS = new Set(['-depth', '-d', '-xdev', '-mount', '-follow', '-L', '-H', '-P', '-noleaf'])
const FIND_WRITE_ACTIONS = new Set(['-fprint', '-fprint0', '-fls', '-fprintf'])
// xargs のオプションのうち、引数を1つとるもの
const XARGS_OPTS_WITH_VALUE = new Set(['-n', '-I', '-L', '-P', '-d', '-s', '-E', '-a'])

// find の引数から -delete と -exec rm を見つけ、消えるものを下見するための引数を作る
export function parseFindDelete(args) {
  const del = args.indexOf('-delete')
  const execRm = args.findIndex((t, i) => EXEC_ACTIONS.has(t) && (args[i + 1] ?? '').split('/').pop() === 'rm')
  if (del === -1 && execRm === -1) return null
  const dryRun = []
  for (let k = 0; k < args.length; k++) {
    const t = args[k]
    if (t === '-delete') continue
    if (EXEC_ACTIONS.has(t)) {
      while (k < args.length && args[k] !== ';' && args[k] !== '+') k++
      continue
    }
    if (FIND_WRITE_ACTIONS.has(t)) {
      k += t === '-fprintf' ? 2 : 1
      continue
    }
    dryRun.push(t)
  }
  // -delete より前に絞り込みの条件がない（例: find . -delete -name x）と、たどったものが全部消える
  let isUnfiltered = false
  if (del !== -1) {
    let k = args.findIndex((t) => t.startsWith('-') || t === '(' || t === '!')
    isUnfiltered = true
    while (k !== -1 && k < del) {
      if (FIND_GLOBAL_OPTS.has(args[k])) k += 2
      else if (FIND_GLOBAL_FLAGS.has(args[k])) k += 1
      else {
        isUnfiltered = false
        break
      }
    }
  }
  return { dryRun, isUnfiltered, via: del !== -1 ? '-delete' : '-exec rm' }
}

// 危険な操作を見つけて返す。各要素は { kind, cwd, ... }。cd と git -C で作業フォルダを追う
// bash -c / sh -c / eval の中身は、同じルールでもう一度調べる
export function detectRisks(command, baseCwd = null) {
  const risks = []
  let cwd = baseCwd
  for (const raw of segments(command)) {
    const tokens = stripPrefix(raw)
    if (!tokens.length) continue
    const name = tokens[0].split('/').pop()
    const args = tokens.slice(1)

    if (name === 'cd' && args[0]) {
      cwd = joinPath(cwd, args[0])
      continue
    }

    if (SHELLS.has(name)) {
      const c = args.findIndex((t) => /^-[A-Za-z]*c[A-Za-z]*$/.test(t))
      if (c !== -1 && args[c + 1]) risks.push(...detectRisks(args[c + 1], cwd))
      continue
    }

    if (name === 'eval' && args.length) {
      risks.push(...detectRisks(args.join(' '), cwd))
      continue
    }

    if (name === 'find') {
      const found = parseFindDelete(args)
      if (found) risks.push({ kind: 'find-delete', cwd, ...found })
      continue
    }

    if (name === 'xargs') {
      let k = 0
      while (k < args.length && isFlag(args[k])) k += XARGS_OPTS_WITH_VALUE.has(args[k]) ? 2 : 1
      if ((args[k] ?? '').split('/').pop() === 'rm') risks.push({ kind: 'xargs-rm', cwd })
      continue
    }

    if (name === 'rm') {
      const flags = shortFlags(args)
      const recursive = /[rR]/.test(flags) || args.includes('--recursive')
      if (!recursive) continue
      const end = args.indexOf('--')
      const targets = args.filter((t, i) => (end !== -1 && i > end) || (!isFlag(t) && (end === -1 || i < end)))
      if (targets.length) risks.push({ kind: 'rm', cwd, targets, force: /f/.test(flags) || args.includes('--force') })
      continue
    }

    if (name !== 'git') continue
    let i = 0
    let gitCwd = cwd
    while (i < args.length && isFlag(args[i])) {
      if (args[i] === '-C') {
        gitCwd = joinPath(gitCwd, args[i + 1] ?? '.')
        i += 2
      } else if (args[i] === '-c') i += 2
      else i++
    }
    const sub = args[i]
    const rest = args.slice(i + 1)
    const positional = rest.filter((t) => !isFlag(t))
    const flags = shortFlags(rest)

    if (sub === 'reset' && rest.includes('--hard')) {
      risks.push({ kind: 'reset-hard', cwd: gitCwd, ref: positional[0] ?? 'HEAD' })
    } else if (
      sub === 'push' &&
      (/f/.test(flags) || rest.some((t) => t.startsWith('--force')) || positional.some((t, n) => n > 0 && t.startsWith('+')))
    ) {
      const refspec = positional[1]?.replace(/^\+/, '')
      const [src, dst] = refspec?.includes(':') ? refspec.split(':') : [refspec, refspec]
      risks.push({ kind: 'force-push', cwd: gitCwd, remote: positional[0] ?? null, src: src || null, dst: dst || null })
    } else if (sub === 'clean' && (/f/.test(flags) || rest.includes('--force'))) {
      // dry-run（-n）に引き継ぐのは対象を広げる -d -x -X だけ
      const dryFlags = [...new Set(flags.split('').filter((c) => c === 'd' || c === 'x' || c === 'X'))]
      risks.push({ kind: 'clean', cwd: gitCwd, flags: dryFlags, paths: positional })
    } else if (sub === 'checkout' && (rest.includes('--') || positional.includes('.'))) {
      const dash = rest.indexOf('--')
      const paths = dash === -1 ? positional.filter((t) => t === '.') : rest.slice(dash + 1)
      if (paths.length) risks.push({ kind: 'discard', cwd: gitCwd, paths })
    } else if (sub === 'restore' && !rest.includes('--staged') && positional.length) {
      risks.push({ kind: 'discard', cwd: gitCwd, paths: positional })
    } else if (sub === 'branch' && (rest.includes('-D') || (rest.includes('--delete') && rest.includes('--force')))) {
      if (positional.length) risks.push({ kind: 'branch-delete', cwd: gitCwd, branches: positional })
    } else if (sub === 'stash' && (rest[0] === 'drop' || rest[0] === 'clear')) {
      risks.push({ kind: 'stash-drop', cwd: gitCwd, action: rest[0], ref: rest[1] ?? null })
    }
  }
  return risks
}

export function joinPath(base, path) {
  if (path.startsWith('/') || path.startsWith('~')) return path
  if (!base) return path
  return base.replace(/\/+$/, '') + '/' + path
}

export function formatBytes(n) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB'
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

const nonEmpty = (text) => text.split('\n').map((l) => l.trimEnd()).filter(Boolean)

// --- 影響範囲の調査（$ を使う） ---

function absolute(path, sessionCwd, home) {
  if (path === '~' || path.startsWith('~/')) return (home ?? '~') + path.slice(1)
  if (path.startsWith('/')) return path
  return sessionCwd.replace(/\/+$/, '') + '/' + path
}

function normalize(path) {
  const out = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

async function git($, cwd, argv) {
  try {
    const r = await $.process.run(['git', ...argv], { cwd: cwd ?? undefined, timeoutMs: 10000 })
    return { ok: r.exitCode === 0, out: r.stdout, err: r.stderr }
  } catch (err) {
    return { ok: false, out: '', err: String(err) }
  }
}

// ディレクトリを幅優先でたどり、ファイル数と合計サイズを数える（上限あり）
async function measure($, path) {
  let files = 0
  let dirs = 0
  let bytes = 0
  let isCapped = false
  const queue = [path]
  while (queue.length) {
    const dir = queue.shift()
    let entries = []
    try {
      entries = await $.fs.list(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (files + dirs >= MAX_WALK) {
        isCapped = true
        break
      }
      if (entry.kind === 'dir' && !entry.isLink) {
        dirs += 1
        queue.push(dir + '/' + entry.name)
      } else {
        files += 1
        bytes += entry.size ?? 0
      }
    }
    if (isCapped) break
  }
  return { files, dirs, bytes, isCapped }
}

async function analyzeRm($, risk, sessionCwd, home, repoRoot) {
  const lines = []
  let severity = 'high'
  let totalFiles = 0
  let totalBytes = 0
  let unknown = 0
  for (const target of risk.targets) {
    if (/[$`]/.test(target)) {
      unknown += 1
      lines.push(target + '  (変数: 実行するまで中身が分からない)')
      continue
    }
    if (/[*?[]/.test(target)) {
      unknown += 1
      lines.push(target + '  (glob: 展開せずに表示)')
      continue
    }
    const path = normalize(absolute(joinPath(risk.cwd, target), sessionCwd, home))
    if (path === '/' || path === home || path === repoRoot || path === normalize(sessionCwd)) {
      severity = 'critical'
    }
    if (!(await $.fs.exists(path))) {
      lines.push(path + '  (存在しない)')
      continue
    }
    const stat = await $.fs.stat(path)
    if (stat.kind === 'dir') {
      const m = await measure($, path)
      totalFiles += m.files
      totalBytes += m.bytes
      lines.push(path + '/  ' + m.files + (m.isCapped ? '+' : '') + ' files · ' + formatBytes(m.bytes))
    } else {
      totalFiles += 1
      totalBytes += stat.size ?? 0
      lines.push(path + '  ' + formatBytes(stat.size ?? 0))
    }
  }
  const where = severity === 'critical' ? '（ルート / ホーム / プロジェクト全体）' : ''
  return {
    title: 'rm -r' + (risk.force ? 'f' : '') + where,
    severity,
    summary:
      totalFiles + ' 個のファイル（' + formatBytes(totalBytes) + '）を削除' + (unknown ? ' + 中身が事前に分からない対象 ' + unknown + ' 件' : ''),
    lines,
  }
}

async function analyzeGit($, risk) {
  if (risk.kind === 'reset-hard') {
    const diff = await git($, risk.cwd, ['diff', '--stat', 'HEAD'])
    const lost = nonEmpty(diff.out)
    const lines = lost.length ? lost : ['コミットされていない変更はありません']
    let summary = lost.length ? 'コミットしていない変更 ' + (lost.length - 1) + ' ファイル分が消える' : '作業ツリーの変更はなし'
    if (risk.ref !== 'HEAD') {
      const log = await git($, risk.cwd, ['log', '--oneline', risk.ref + '..HEAD'])
      const commits = nonEmpty(log.out)
      if (commits.length) {
        summary += ' · ' + commits.length + ' コミットがブランチから外れる'
        lines.push('', risk.ref + ' より先のコミット:', ...commits)
      }
    }
    return { title: 'git reset --hard ' + risk.ref, severity: lost.length ? 'high' : 'low', summary, lines }
  }

  if (risk.kind === 'force-push') {
    const branch = risk.dst ?? (await git($, risk.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim()
    const remote = risk.remote ?? 'origin'
    const local = risk.src ?? 'HEAD'
    const remoteRef = remote + '/' + branch
    const exists = await git($, risk.cwd, ['rev-parse', '--verify', '--quiet', remoteRef])
    if (!exists.ok) {
      return { title: 'git push --force → ' + remoteRef, severity: 'low', summary: 'リモートにまだこのブランチがない（前回の fetch 時点）', lines: [] }
    }
    const log = await git($, risk.cwd, ['log', '--oneline', local + '..' + remoteRef])
    const commits = nonEmpty(log.out)
    return {
      title: 'git push --force → ' + remoteRef,
      severity: commits.length ? 'critical' : 'low',
      summary: commits.length ? 'リモートの ' + commits.length + ' コミットが上書きで消える（前回の fetch 時点）' : '消えるリモートのコミットはなし（前回の fetch 時点）',
      lines: commits,
    }
  }

  if (risk.kind === 'clean') {
    const flags = risk.flags.length ? ['-' + risk.flags.join('')] : []
    const dry = await git($, risk.cwd, ['clean', '-n', ...flags, '--', ...risk.paths])
    const lines = nonEmpty(dry.out).map((l) => l.replace(/^Would remove /, ''))
    return {
      title: 'git clean -f' + risk.flags.join(''),
      severity: lines.length ? 'high' : 'low',
      summary: lines.length ? '追跡されていない ' + lines.length + ' 件を削除' : '削除されるものはなし',
      lines,
    }
  }

  if (risk.kind === 'discard') {
    const diff = await git($, risk.cwd, ['diff', '--stat', '--', ...risk.paths])
    const lines = nonEmpty(diff.out)
    return {
      title: '変更を破棄: ' + risk.paths.join(' '),
      severity: lines.length ? 'high' : 'low',
      summary: lines.length ? 'コミットしていない変更 ' + (lines.length - 1) + ' ファイル分が消える' : '破棄される変更はなし',
      lines,
    }
  }

  if (risk.kind === 'branch-delete') {
    const lines = []
    let total = 0
    for (const branch of risk.branches) {
      const log = await git($, risk.cwd, ['log', '--oneline', 'HEAD..' + branch])
      const commits = nonEmpty(log.out)
      total += commits.length
      lines.push(branch + ': ' + (commits.length ? '未マージ ' + commits.length + ' コミット' : 'マージ済み'), ...commits.map((c) => '  ' + c))
    }
    return {
      title: 'git branch -D ' + risk.branches.join(' '),
      severity: total ? 'high' : 'low',
      summary: total ? 'どこにもマージされていない ' + total + ' コミットが消える' : '未マージのコミットはなし',
      lines,
    }
  }

  // stash-drop
  const list = await git($, risk.cwd, ['stash', 'list'])
  const all = nonEmpty(list.out)
  const lines = risk.action === 'clear' ? all : all.filter((l) => l.startsWith((risk.ref ?? 'stash@{0}') + ':'))
  return {
    title: 'git stash ' + risk.action,
    severity: lines.length ? 'high' : 'low',
    summary: lines.length ? lines.length + ' 件の stash が消える' : '消える stash はなし',
    lines,
  }
}

// find を -delete / -exec rm 抜きで実行して、消える予定のものを一覧にする
async function analyzeFind($, risk, sessionCwd, home, repoRoot) {
  // 条件より前に並ぶのが起点のフォルダ。省略されたら find は . から始める
  const firstExpr = risk.dryRun.findIndex((t) => t.startsWith('-') || t === '(' || t === '!')
  const roots = firstExpr === -1 ? risk.dryRun : risk.dryRun.slice(0, firstExpr)
  const paths = (roots.length ? roots : ['.']).map((r) => normalize(absolute(joinPath(risk.cwd, r), sessionCwd, home)))
  const isWide = paths.some((p) => p === '/' || p === home || p === repoRoot || p === normalize(sessionCwd))
  let lines = []
  try {
    const r = await $.process.run(['find', ...risk.dryRun], { cwd: risk.cwd ?? undefined, timeoutMs: 15000 })
    lines = nonEmpty(r.stdout)
  } catch {
    return { title: 'find ' + risk.via, severity: 'high', summary: '消えるものの一覧を作れませんでした（時間切れなど）', lines: [] }
  }
  const severity = risk.isUnfiltered || (isWide && lines.length > 100) ? 'critical' : lines.length ? 'high' : 'low'
  const note = risk.isUnfiltered ? '（-delete が条件より前にあるので、たどったものが全部消える）' : ''
  return {
    title: 'find ' + risk.via + note,
    severity,
    summary: lines.length ? lines.length + ' 件を削除' : '削除されるものはなし',
    lines,
  }
}

async function analyze($, risk) {
  const sessionCwd = await $.session.cwd()
  if (risk.kind === 'xargs-rm') {
    return { title: 'xargs rm', severity: 'high', summary: 'パイプで渡されたファイルを削除（対象は実行時に決まるので事前に数えられない）', lines: [] }
  }
  if (risk.kind !== 'rm' && risk.kind !== 'find-delete') return analyzeGit($, risk)
  const home = (await $.env.get('HOME')) ?? null
  const top = await git($, null, ['rev-parse', '--show-toplevel'])
  const repoRoot = top.ok ? top.out.trim() : null
  if (risk.kind === 'find-delete') return analyzeFind($, risk, sessionCwd, home, repoRoot)
  return analyzeRm($, risk, sessionCwd, home, repoRoot)
}

const SEVERITY = { critical: 3, high: 2, low: 1 }
const SEVERITY_COLOR = { critical: '#e5534b', high: '#d29922', low: '#8b949e' }
const SEVERITY_ICON = { critical: '⛔', high: '⚠', low: '·' }

export function worst(impacts) {
  return impacts.reduce((a, b) => (SEVERITY[b.severity] > SEVERITY[a] ? b.severity : a), 'low')
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'blast-radius', description: '最近止めた危険なコマンドと影響範囲のペインを開く', immediate: true })
    return next(e)
  })

  on('command.run', { command: 'blast-radius' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'Blast radius', focus: true, closeOnEscape: true })
    return catches.length ? {} : { text: 'まだ危険なコマンドは捕まえていません' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const risks = detectRisks(e.command ?? '')
    if (!risks.length) return next(e)

    const impacts = []
    for (const risk of risks) impacts.push(await analyze($, risk))
    // 影響がないとわかったものだけなら止めない
    const severity = worst(impacts)
    const entry = { command: e.command, impacts, status: 'pending' }
    catches = [entry, ...catches].slice(0, HISTORY_SIZE)
    const summary = impacts.map((x) => x.summary).join(' / ')
    $.ui.invalidate('ui.render')
    if (severity === 'low') {
      entry.status = 'allowed'
      $.ui.log('Blast radius: ' + summary)
      return next(e)
    }

    await $.ui.open({ id: PANE, title: 'Blast radius' })
    $.ui.log('Blast radius: ' + summary)

    // 確認できる相手がいない（claude -p など）ときは、いつもの権限確認に任せる
    const surfaces = await $.session.surfaces()
    if (!surfaces.length) return next(e)

    let answer = null
    try {
      answer = await $.ui.ask((severity === 'critical' ? '⛔ ' : '⚠ ') + summary + '。このコマンドを実行しますか？', {
        header: 'Blast',
        options: ['実行する', '止める'],
      })
    } catch {
      answer = null
    }
    if (answer === '実行する') {
      entry.status = 'allowed'
      $.ui.invalidate('ui.render')
      return next(e)
    }
    entry.status = 'blocked'
    $.ui.invalidate('ui.render')
    return { deny: 'Blast Radius: ユーザーがこのコマンドを止めました（' + summary + '）。別の方法を検討するか、ユーザーに確認してください。' }
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    if (!catches.length) return Text({ dimColor: true, children: ['まだ危険なコマンドは捕まえていません'] })

    const [latest, ...older] = catches
    const statusText = { pending: '確認待ち', allowed: '実行した', blocked: '止めた' }
    const statusColor = { pending: '#d29922', allowed: '#8b949e', blocked: '#3fb950' }

    const impactBox = (impact, i) =>
      Box({
        key: 'impact-' + i,
        flexDirection: 'column',
        borderStyle: 'round',
        paddingX: 1,
        children: [
          Text({ bold: true, color: SEVERITY_COLOR[impact.severity], children: [SEVERITY_ICON[impact.severity] + ' ' + impact.title] }),
          Text({ children: [impact.summary] }),
          ...impact.lines.slice(0, MAX_LINES).map((l) => Text({ dimColor: true, wrap: 'truncate-end', children: [l || ' '] })),
          ...(impact.lines.length > MAX_LINES ? [Text({ dimColor: true, children: ['… ほか ' + (impact.lines.length - MAX_LINES) + ' 行'] })] : []),
        ],
      })

    return Box({
      flexDirection: 'column',
      children: [
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Text({ bold: true, children: ['$ ' + latest.command] }),
            Text({ color: statusColor[latest.status], children: [statusText[latest.status]] }),
          ],
        }),
        ...latest.impacts.map(impactBox),
        ...(older.length
          ? [
              Text({ children: [' '] }),
              Text({ dimColor: true, children: ['これまでに捕まえたコマンド'] }),
              ...older.map((c) => Text({ dimColor: true, wrap: 'truncate-end', children: [statusText[c.status] + '  $ ' + c.command] })),
            ]
          : []),
      ],
    })
  })
}
