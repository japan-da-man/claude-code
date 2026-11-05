import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_CONFIG,
  classifyFindings,
  classifyRisk,
  compareRuns,
  diffFiles,
  fingerprint,
  globToRegExp,
  loadCases,
  loadConfig,
  loadRun,
  nextCaseId,
  outcomeStats,
  parseDiff,
  readOutcomes,
  runCheck,
  scoreRun,
  validateCase,
} from '../scripts/check.mjs'
import { bugCase, cleanCase, commitAll, git, makeGitRepo, makeRepo, writeFiles } from './helpers.mjs'

const CHECK = fileURLToPath(new URL('../scripts/check.mjs', import.meta.url))
const cfg = structuredClone(DEFAULT_CONFIG)
const file = (path, extra = {}) => ({ path, old_path: null, status: 'modified', added: [[1, 1]], removed_at: [], additions: 1, deletions: 0, binary: false, ...extra })

test('パスの書き方: / のない名前はどの階層にも当たり、/ を含むものはルートから', () => {
  const m = (g, p) => globToRegExp(g).test(p)
  assert.ok(m('*.md', 'docs/a/b.md'))
  assert.ok(m('*.md', 'README.md'))
  assert.ok(m('docs/**', 'docs/a/b.md'))
  assert.ok(!m('docs/**', 'src/docs/a.md'))
  assert.ok(m('**/auth/**', 'auth/a.ts'))
  assert.ok(m('**/auth/**', 'api/src/auth/session.ts'))
  assert.ok(!m('**/auth/**', 'api/src/author.ts'))
  assert.ok(m('app.config.*', 'app.config.ts'))
  assert.ok(m('app.config.*', 'apps/mobile/app.config.js'))
  assert.ok(m('/eas.json', 'eas.json'))
  assert.ok(!m('/eas.json', 'apps/eas.json'))
  assert.ok(m('migrations/', 'migrations/001.sql'))
  assert.ok(m('**/payment*/**', 'api/payments/stripe.ts'))
  assert.ok(m('src/?.ts', 'src/a.ts'))
  assert.ok(!m('src/?.ts', 'src/ab.ts'))
})

test('parseDiff: 追加した行の範囲、消しただけの位置、新規・削除・名前の変更・バイナリ', () => {
  const text = `diff --git a/api/fav.ts b/api/fav.ts
index 1..2 100644
--- a/api/fav.ts
+++ b/api/fav.ts
@@ -10,0 +11,2 @@ export function x() {
+  const a = 1
+  const b = 2
@@ -20,2 +21,0 @@
-  check()
-  check2()
@@ -30 +29 @@
-old
+new
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,3 @@
+a
+b
+c
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
diff --git a/api/auth/x.ts b/api/util/x.ts
similarity index 90%
rename from api/auth/x.ts
rename to api/util/x.ts
--- a/api/auth/x.ts
+++ b/api/util/x.ts
@@ -1 +1 @@
-+++ not a header
++++ also content
\\ No newline at end of file
diff --git a/icon.png b/icon.png
Binary files a/icon.png and b/icon.png differ
`
  const files = parseDiff(text)
  assert.deepEqual(
    files.map((f) => [f.path, f.old_path, f.status]),
    [
      ['api/fav.ts', null, 'modified'],
      ['new.ts', null, 'added'],
      ['gone.ts', null, 'deleted'],
      ['api/util/x.ts', 'api/auth/x.ts', 'renamed'],
      ['icon.png', null, 'modified'],
    ],
  )
  assert.deepEqual(files[0].added, [[11, 12], [29, 29]])
  assert.deepEqual(files[0].removed_at, [21])
  assert.equal(files[0].additions, 3)
  assert.equal(files[0].deletions, 3)
  assert.deepEqual(files[1].added, [[1, 3]])
  assert.equal(files[2].deletions, 2)
  assert.equal(files[3].additions, 1)
  assert.equal(files[3].deletions, 1)
  assert.equal(files[4].binary, true)
})

test('classifyRisk: 1 つでも高リスクのパスに当たれば high、動作に関わらないファイルだけなら low、ほかは standard', () => {
  const high = classifyRisk([file('README.md'), file('api/src/auth/session.ts')], cfg)
  assert.equal(high.tier, 'high')
  assert.equal(high.mode, 'deep')
  assert.equal(high.human_approval, 'other')
  assert.match(high.reasons[0], /認証・認可: api\/src\/auth\/session.ts/)

  const low = classifyRisk([file('docs/a.md'), file('features/F-001-x.yaml')], cfg)
  assert.equal(low.tier, 'low')
  assert.equal(low.mode, 'quick')
  assert.equal(low.human_approval, 'author')

  const std = classifyRisk([file('docs/a.md'), file('app/screens/Home.tsx')], cfg)
  assert.equal(std.tier, 'standard')
  assert.equal(std.mode, 'standard')
  assert.equal(std.human_approval, 'author')

  // 名前を変えて高リスクの場所から出しても high
  assert.equal(classifyRisk([file('api/util/x.ts', { old_path: 'api/auth/x.ts', status: 'renamed' })], cfg).tier, 'high')
  // 削除も
  assert.equal(classifyRisk([file('.github/workflows/ci.yml', { status: 'deleted' })], cfg).tier, 'high')
})

test('classifyRisk: 大きい変更は deep に、承認は作者が trusted かと設定で決まる', () => {
  const big = classifyRisk([file('app/a.ts', { additions: 300, deletions: 200 })], cfg)
  assert.equal(big.tier, 'standard')
  assert.equal(big.mode, 'deep')
  assert.ok(big.reasons.some((r) => r.includes('500 行')))

  const c = structuredClone(cfg)
  c.approvals.trusted_authors = ['nao']
  assert.equal(classifyRisk([file('app/a.ts')], c, { author: 'nao' }).human_approval, 'author')
  const other = classifyRisk([file('app/a.ts')], c, { author: 'bot' })
  assert.equal(other.human_approval, 'other')
  assert.ok(other.notes.some((n) => n.includes('bot')))

  c.approvals.auto_merge_low = true
  assert.equal(classifyRisk([file('docs/a.md')], c).human_approval, 'none')

  c.approvals.high_needs_other = false
  assert.equal(classifyRisk([file('eas.json')], c, { author: 'nao' }).human_approval, 'author')
  // trusted でない作者の高リスクは、設定によらず作者以外が要る
  assert.equal(classifyRisk([file('eas.json')], c, { author: 'bot' }).human_approval, 'other')
})

test('classifyFindings: 変更の中（追加した行・消した位置のそば）なら introduced、外は pre-existing', () => {
  const files = parseDiff(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10,0 +11,2 @@
+x
+y
@@ -40,3 +41,0 @@
-p
-q
-r
diff --git a/n.ts b/n.ts
new file mode 100644
--- /dev/null
+++ b/n.ts
@@ -0,0 +1 @@
+n
`)
  const out = classifyFindings(
    [
      { path: 'a.ts', line: 12, class: 'null', title: 'a' },
      { path: 'a.ts', line: 42, class: 'check', title: 'b' },
      { path: 'a.ts', line: 80, class: 'old', title: 'c' },
      { path: 'a.ts', line: 80, class: 'exposed', title: 'd', caused_by_change: '11 行目で引数が null になりうるようになった' },
      { path: 'other.ts', line: 1, class: 'old', title: 'e' },
      { path: 'n.ts', line: 99, class: 'new', title: 'f' },
    ],
    files,
  )
  assert.deepEqual(
    out.map((f) => f.origin),
    ['introduced', 'introduced', 'pre-existing', 'introduced', 'pre-existing', 'introduced'],
  )
  assert.equal(out[3].in_diff, false)
  assert.equal(out[0].fp, fingerprint({ path: 'a.ts', class: 'null', title: 'a' }))
})

test('fingerprint: 句読点や空白、大文字小文字の違いでは変わらない', () => {
  assert.equal(fingerprint({ path: 'a.ts', class: 'Null', title: 'x が  null になる。' }), fingerprint({ path: 'a.ts', class: 'null', title: 'x が null になる' }))
  assert.notEqual(fingerprint({ path: 'a.ts', class: 'null', title: 'x' }), fingerprint({ path: 'b.ts', class: 'null', title: 'x' }))
})

test('validateCase: 形の誤りを落とす', () => {
  assert.deepEqual(validateCase(bugCase(), 'review/evals/cases/C-001-cache.json'), [])
  assert.deepEqual(validateCase(cleanCase(), 'review/evals/cases/C-002.json'), [])
  const rules = (c, f = 'review/evals/cases/C-001-x.json') => validateCase(c, f).map((e) => e.rule)
  assert.deepEqual(rules(bugCase(), 'review/evals/cases/C-009-x.json'), ['filename'])
  assert.deepEqual(rules(bugCase({ bugs: [] })), ['bugs'])
  assert.deepEqual(rules(cleanCase({ id: 'C-001', bugs: bugCase().bugs })), ['bugs'])
  assert.deepEqual(rules(bugCase({ introduced: { base: 'xyz', head: 'b'.repeat(40) } })), ['introduced'])
  assert.deepEqual(rules(bugCase({ verified_by: '' })), ['verified_by'])
  const bad = bugCase()
  bad.bugs[1] = { ...bad.bugs[1], id: 'B1', lines: [5, 2], severity: 'huge', trigger: '' }
  assert.equal(rules(bad).length, 4)
})

test('loadCases と nextCaseId: 読めないファイルと ID の重複を落とし、次の番号を出す', () => {
  const repo = makeRepo({
    'review/evals/cases/C-001-cache.json': bugCase(),
    'review/evals/cases/C-002-copy.json': cleanCase(),
    'review/evals/cases/C-007-dup.json': cleanCase({ id: 'C-002' }),
    'review/evals/cases/C-008-broken.json': '{',
  })
  const { cases, errors } = loadCases(repo)
  assert.deepEqual(cases.map((c) => c.id), ['C-001', 'C-002'])
  assert.deepEqual(errors.map((e) => e.rule).sort(), ['filename', 'id', 'parse'])
  assert.equal(nextCaseId(repo), 'C-009')
  assert.equal(nextCaseId(makeRepo()), 'C-001')
})

function writeRun(repo, name, { findings, judgments, label = name }) {
  const dir = `review/evals/runs/${name}`
  const files = { [`${dir}/run.json`]: { label } }
  for (const [k, v] of Object.entries(findings)) files[`${dir}/findings/${k}.json`] = v
  for (const [k, v] of Object.entries(judgments)) files[`${dir}/judgments/${k}.json`] = v
  writeFiles(repo, files)
  return join(repo, dir)
}

const f = (title) => ({ path: 'api/fav.ts', line: 10, class: 'x', title })
const v = (verdicts) => verdicts.map((verdict, index) => ({ index, verdict }))

function baseRun(repo, name = 'r1') {
  return writeRun(repo, name, {
    findings: { 'C-001': [f('B1'), f('B2'), f('nit')], 'C-001.2': [f('B1'), f('other')], 'C-002': [f('bad')], 'C-002.2': [] },
    judgments: {
      'C-001': { bugs: [{ bug: 'B1', caught: true, finding: 0 }, { bug: 'B2', caught: true, finding: 1 }], findings: v(['tp', 'tp', 'noise']) },
      'C-001.2': { bugs: [{ bug: 'B1', caught: true, finding: 0 }, { bug: 'B2', caught: false }], findings: v(['tp', 'real_unlisted']) },
      'C-002': { bugs: [], findings: v(['harmful']) },
      'C-002.2': { bugs: [], findings: [] },
    },
  })
}

test('scoreRun: 重みつき recall・precision・問題のない変更での誤指摘を出す', () => {
  const repo = makeRepo({ 'review/evals/cases/C-001-cache.json': bugCase(), 'review/evals/cases/C-002-copy.json': cleanCase() })
  const s = scoreRun(loadCases(repo).cases, loadRun(baseRun(repo)), cfg)
  assert.deepEqual(s.errors, [])
  assert.equal(s.repeats, 2)
  assert.equal(s.cases, 2)
  // (high 2 × 2 回 + low 0.5 × 1 回) / (2 × 2 + 0.5 × 2)
  assert.equal(s.metrics.weighted_recall, 0.9)
  assert.equal(s.metrics.recall, 0.75)
  assert.equal(s.metrics.severe_recall, 1)
  assert.equal(s.metrics.precision, 4 / 6)
  assert.equal(s.metrics.clean_findings_per_run, 0.5)
  assert.equal(s.metrics.clean_harmful_rate, 0.5)
  assert.equal(s.metrics.harmful, 1)
  assert.equal(s.real_unlisted.length, 1)
  assert.equal(s.real_unlisted[0].finding.title, 'other')
  assert.deepEqual(s.bugs.map((b) => [b.bug, b.rate]), [['B1', 1], ['B2', 0.5]])
})

test('scoreRun: 判定の抜けや食い違い、ないケースを誤りにする', () => {
  const repo = makeRepo({ 'review/evals/cases/C-001-cache.json': bugCase(), 'review/evals/cases/C-002-copy.json': cleanCase() })
  const dir = writeRun(repo, 'bad', {
    findings: { 'C-001': [f('a'), f('b')], 'C-003': [] },
    judgments: {
      'C-001': { bugs: [{ bug: 'B1', caught: true, finding: 1 }], findings: v(['tp', 'noise']) },
      'C-003': { bugs: [], findings: [] },
    },
  })
  const s = scoreRun(loadCases(repo).cases, loadRun(dir), cfg)
  assert.equal(s.ok, false)
  const msgs = s.errors.map((e) => e.message).join('\n')
  assert.match(msgs, /B2 の判定がない/)
  assert.match(msgs, /B1 を見つけたなら/)
  assert.match(msgs, /C-003 のケースがない/)
  assert.deepEqual(s.not_run, ['C-002'])
})

test('compareRuns: 見つけられなくなったバグと悪化を出す', () => {
  const repo = makeRepo({ 'review/evals/cases/C-001-cache.json': bugCase(), 'review/evals/cases/C-002-copy.json': cleanCase() })
  const { cases } = loadCases(repo)
  const a = scoreRun(cases, loadRun(baseRun(repo, 'a')), cfg)
  const bDir = writeRun(repo, 'b', {
    findings: { 'C-001': [f('B2')], 'C-001.2': [f('B2')], 'C-002': [], 'C-002.2': [] },
    judgments: {
      'C-001': { bugs: [{ bug: 'B1', caught: false }, { bug: 'B2', caught: true, finding: 0 }], findings: v(['tp']) },
      'C-001.2': { bugs: [{ bug: 'B1', caught: false }, { bug: 'B2', caught: true, finding: 0 }], findings: v(['tp']) },
      'C-002': { bugs: [], findings: [] },
      'C-002.2': { bugs: [], findings: [] },
    },
  })
  const b = scoreRun(cases, loadRun(bDir), cfg)
  const c = compareRuns(a, b)
  assert.deepEqual(c.regressions.map((r) => [r.bug, r.before, r.after]), [['B1', 1, 0]])
  assert.deepEqual(c.improvements.map((r) => [r.bug, r.before, r.after]), [['B2', 0.5, 1]])
  assert.ok(c.worse.includes('critical / high の recall が下がった'))
  assert.equal(c.delta.clean_harmful_rate, -0.5)
  assert.equal(c.same_cases, true)
})

test('loadConfig: 既定値に重ね、高リスクのパスは丸ごと置き換える。誤りは落とす', () => {
  const repo = makeRepo({ 'review/config.json': { risk: { high: { 課金: ['**/iap/**'] } }, review: { max_rounds: 2 } } })
  const { config, errors } = loadConfig(repo)
  assert.deepEqual(errors, [])
  assert.deepEqual(Object.keys(config.risk.high), ['課金'])
  assert.equal(config.review.max_rounds, 2)
  assert.equal(config.review.modes.high, 'deep')
  assert.equal(config.risk.large_change_lines, 400)

  const bad = makeRepo({ 'review/config.json': { checks: [{ name: 'test' }], review: { modes: { low: 'fast' }, max_rounds: 0 }, approvals: { auto_merge_low: 'yes' } } })
  assert.deepEqual(loadConfig(bad).errors.map((e) => e.rule).sort(), ['approvals', 'checks', 'review', 'review'])
  assert.equal(loadConfig(makeRepo({ 'review/config.json': '{' })).errors[0].rule, 'parse')
})

test('runCheck と対応結果: 形の誤りは誤り、設定や REVIEW.md がないのは警告', () => {
  const empty = runCheck(makeRepo())
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.warnings.map((w) => w.rule), ['config', 'review-md'])

  const repo = makeRepo({
    'REVIEW.md': '# r\n',
    'review/config.json': {},
    'review/evals/cases/C-001-cache.json': bugCase(),
    'review/outcomes.jsonl': '{"outcome":"fixed","severity":"high","class":"cache"}\n\n{"outcome":"meh"}\nnot json\n{"outcome":"rejected","severity":"high","class":"cache"}\n',
  })
  const r = runCheck(repo)
  assert.equal(r.ok, false)
  assert.equal(r.errors.length, 2)
  assert.equal(r.counts.bug_cases, 1)
  const { rows } = readOutcomes(repo)
  const s = outcomeStats(rows)
  assert.equal(s.total, 2)
  assert.equal(s.acted_rate, 0.5)
  assert.deepEqual(s.by_severity.high, { fixed: 1, rejected: 1, intentional: 0, ignored: 0 })
})

test('git と通して: コミットの範囲と作業ツリー（まだ追跡していないファイルも）からリスク段階を出す', () => {
  const repo = makeGitRepo({ 'README.md': '# app\n', 'app/a.ts': 'export const a = 1\n' })
  git(repo, 'switch', '-qc', 'feat')
  writeFiles(repo, { 'app/a.ts': 'export const a = 2\nexport const b = 3\n' })
  const head = commitAll(repo)
  const committed = diffFiles(repo, { base: 'main', head })
  assert.deepEqual(committed.files.map((x) => [x.path, x.added]), [['app/a.ts', [[1, 2]]]])
  assert.equal(classifyRisk(committed.files, cfg).tier, 'standard')

  writeFiles(repo, { 'api/auth/session.ts': 'a\nb\nc\n' })
  const work = diffFiles(repo, { base: 'main' })
  const untracked = work.files.find((x) => x.path === 'api/auth/session.ts')
  assert.deepEqual(untracked.added, [[1, 3]])
  assert.equal(classifyRisk(work.files, cfg).tier, 'high')

  // 写した check.mjs はプラグインなしで動く
  const r = spawnSync(process.execPath, [CHECK, 'risk', '--repo', repo, '--base', 'main'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /リスク段階: \*\*high\*\*/)
  const j = spawnSync(process.execPath, [CHECK, 'risk', '--repo', repo, '--base', 'main', '--head', head, '--json'], { encoding: 'utf8' })
  assert.equal(JSON.parse(j.stdout).tier, 'standard')
  const none = spawnSync(process.execPath, [CHECK, 'risk', '--repo', repo], { encoding: 'utf8' })
  assert.equal(none.status, 2)
  assert.match(none.stderr, /--base/)
})

test('check.mjs の CLI: 形のチェックは誤りで終了コード 1、score と compare は JSON でも出せる', () => {
  const repo = makeRepo({ 'review/evals/cases/C-001-cache.json': bugCase(), 'review/evals/cases/C-002-copy.json': cleanCase() })
  baseRun(repo, 'a')
  const ok = spawnSync(process.execPath, [CHECK, repo], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stdout)
  assert.match(ok.stdout, /問題なし（ケース 2 件・実行 1 回）/)
  const score = spawnSync(process.execPath, [CHECK, 'score', 'review/evals/runs/a', '--repo', repo], { encoding: 'utf8' })
  assert.equal(score.status, 0, score.stdout)
  assert.match(score.stdout, /重みつき recall \| 90\.0%/)
  assert.match(score.stdout, /C-001\/B2（low）: 1\/2 回/)
  const cmp = spawnSync(process.execPath, [CHECK, 'compare', 'review/evals/runs/a', 'review/evals/runs/a', '--repo', repo, '--json'], { encoding: 'utf8' })
  assert.equal(cmp.status, 0)
  assert.deepEqual(JSON.parse(cmp.stdout).worse, [])
  writeFiles(repo, { 'review/evals/cases/C-003-x.json': '{' })
  assert.equal(spawnSync(process.execPath, [CHECK, repo], { encoding: 'utf8' }).status, 1)
})

test('risk --config: 別のリポジトリの設定で判定する（eval では今の設定で古い変更を測る）', () => {
  const repo = makeGitRepo({ 'README.md': '# app\n', 'app/iap/buy.ts': 'a\n' })
  git(repo, 'switch', '-qc', 'feat')
  writeFiles(repo, { 'app/iap/buy.ts': 'b\n' })
  const head = commitAll(repo)
  const current = makeRepo({ 'review/config.json': { risk: { high: { 課金: ['**/iap/**'] } } } })
  const run = (...extra) => JSON.parse(spawnSync(process.execPath, [CHECK, 'risk', '--repo', repo, '--base', 'main', '--head', head, '--json', ...extra], { encoding: 'utf8' }).stdout)
  assert.equal(run().tier, 'standard')
  assert.equal(run('--config', join(current, 'review/config.json')).tier, 'high')
  const missing = spawnSync(process.execPath, [CHECK, 'risk', '--repo', repo, '--base', 'main', '--config', join(current, 'nope.json')], { encoding: 'utf8' })
  assert.equal(missing.status, 2)
})
