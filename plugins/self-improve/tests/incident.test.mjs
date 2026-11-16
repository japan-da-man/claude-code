// 失敗票。全リポジトリの分を、user 側の ~/.claude/self-improve/incidents/ に置く。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeRemote } from '../scripts/lib/incidents.mjs'
import { at, draft, finishAuto, makeEnv, note, repoId, script, seedCandidates, startAuto, writeFiles } from './helpers.mjs'

const ADD = ['incident', 'add', '--session', 'human-1', '--key', 'route-placement', '--root-cause', 'knowledge', '--category', 'dev/mistake',
  '--asked', 'ユーザー一覧の API を足す', '--expected', 'src/routes/ にルートを置く', '--actual', 'src/api/ に置いた']
const incidentText = (t, id) => readFileSync(join(t.user, 'incidents', `${id}.md`), 'utf8')
// もう 1 つのリポジトリを、同じホーム（同じ user 側の置き場所）で作る。
function secondRepo(t, name) {
  const repo = join(t.base, name)
  mkdirSync(join(repo, '.git'), { recursive: true })
  return { ...t, repo, name }
}
const gitConfig = (t, url) => writeFileSync(join(t.repo, '.git/config'), `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://example.com/up/stream.git\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n`)

test('incident add: user 側に起票する。ID は全リポジトリで 1 つの連番。どのリポジトリで起きたかと、リモートの URL を記録する', () => {
  const t = makeEnv()
  gitConfig(t, 'https://x-access-token:ghs_SECRETSECRET@github.com/acme/demo-app.git')
  const first = note(t, [...ADD, '--evidence', 'コミット abc123'], { now: at(0) })
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /^失敗票を起票しました：INC-2026-0001（~\/\.claude\/self-improve\/incidents\/INC-2026-0001\.md）\n$/)
  const text = incidentText(t, 'INC-2026-0001')
  for (const line of [
    'id: INC-2026-0001', 'date: 2026-11-16', 'repo: demo-app', `repo_id: ${repoId(t)}`, 'remote: https://github.com/acme/demo-app.git',
    'category: dev/mistake', 'signal: noticed', 'root_cause: knowledge', 'cause_key: route-placement', 'related: []', 'severity: normal',
    'status: open', 'control: null', 'applied_by: human',
  ]) assert.match(text, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'), line)
  assert.match(text, /## 何を頼んだか\n\nユーザー一覧の API を足す\n\n## 期待した結果\n\nsrc\/routes\/ にルートを置く\n\n## 実際の結果\n\nsrc\/api\/ に置いた\n\n## 根拠\n\nコミット abc123/)
  // 認証情報は、どこにも残らない
  assert.doesNotMatch(text, /ghs_|x-access-token/)
  // リポジトリには、何も書かない
  assert.deepEqual(readdirSync(t.repo), ['.git'])

  // 別のリポジトリで起票しても、番号は続く（全体で 1 つの連番）
  const other = secondRepo(t, 'other-app')
  assert.match(note(other, [...ADD], { now: at(1) }).stdout, /INC-2026-0002/)
  assert.match(incidentText(t, 'INC-2026-0002'), /^repo: other-app$/m)
  // 同じ原因の票（今のリポジトリの分だけ）を related に入れる。別のリポジトリの INC-2026-0002 は入らない
  const third = note(t, [...ADD, '--status', 'trial', '--control', 'trial:rules/route-placement'], { now: at(2) })
  assert.match(third.stdout, /INC-2026-0003.*\n同じ原因の失敗票（このリポジトリ）：INC-2026-0001\n/)
  assert.match(incidentText(t, 'INC-2026-0003'), /^related: \[INC-2026-0001\]$/m)
  // 年が変われば、その年の 1 番から
  assert.match(note(t, [...ADD], { now: at(0, 60) }).stdout, /INC-2027-0001/)

  // 一覧は、今のリポジトリの票だけ。--all で全リポジトリ
  assert.deepEqual(note(t, ['incident', 'list', '--json']).json.map((i) => i.id), ['INC-2026-0001', 'INC-2026-0003', 'INC-2027-0001'])
  assert.deepEqual(note(t, ['incident', 'list', '--all', '--json']).json.map((i) => [i.id, i.repo]),
    [['INC-2026-0001', 'demo-app'], ['INC-2026-0002', 'other-app'], ['INC-2026-0003', 'demo-app'], ['INC-2027-0001', 'demo-app']])
  assert.match(note(t, ['incident', 'show', 'INC-2026-0003']).stdout, /^status: trial$/m)
  assert.equal(note(t, ['incident', 'show', 'INC-2026-0099']).status, 1)
})

test('リモートの URL から、認証情報を取り除く（漏れがないように）。ローカルのパスは記録しない', () => {
  const cases = [
    ['https://github.com/acme/app.git', 'https://github.com/acme/app.git'],
    ['https://user@github.com/acme/app.git', 'https://github.com/acme/app.git'],
    ['https://user:p4ssw0rd@github.com/acme/app.git', 'https://github.com/acme/app.git'],
    ['https://x-access-token:ghs_abcDEF123@github.com/acme/app', 'https://github.com/acme/app'],
    ['https://oauth2:glpat-xyz@gitlab.example.com:8443/group/app.git', 'https://gitlab.example.com:8443/group/app.git'],
    // パスワードに @ が入っていても、最後の @ までを取り除く
    ['https://user:p@ss@w0rd@example.com/acme/app.git', 'https://example.com/acme/app.git'],
    ['HTTPS://Token@Example.com/acme/app.git', 'https://Example.com/acme/app.git'],
    // クエリやフラグメントに付けたトークンも落とす
    ['https://example.com/acme/app.git?access_token=abc123&x=1', 'https://example.com/acme/app.git'],
    ['https://example.com/acme/app.git#token=abc', 'https://example.com/acme/app.git'],
    ['ssh://git@github.com/acme/app.git', 'ssh://github.com/acme/app.git'],
    ['ssh://deploy:secret@host.example.com:2222/srv/app.git', 'ssh://host.example.com:2222/srv/app.git'],
    // scp の形：git は利用者名で、認証情報ではない。ほかの名前（トークンのことがある）は落とす
    ['git@github.com:acme/app.git', 'git@github.com:acme/app.git'],
    ['ghp_tokenvalue@github.com:acme/app.git', 'github.com:acme/app.git'],
    ['github.com:acme/app.git', 'github.com:acme/app.git'],
    // :// のない形でも、@ を含めば、最後の @ までを落とす（利用者名:トークン@ の形）
    ['user:ghp_tokenvalue@github.com:acme/app.git', 'github.com:acme/app.git'],
    ['git:secret@github.com:acme/app.git', 'github.com:acme/app.git'],
    ['a@b@github.com:acme/app.git', 'github.com:acme/app.git'],
    // ; のパラメーター、クエリ、フラグメントも落とす
    ['https://example.com/acme/app.git;token=abc', 'https://example.com/acme/app.git'],
    ['https://example.com;token=abc/acme/app.git', 'https://example.com/acme/app.git'],
    ['git@github.com:acme/app.git;token=abc', 'git@github.com:acme/app.git'],
    ['github.com:acme/app.git?token=abc#x', 'github.com:acme/app.git'],
    // ローカルのパス（マシンの中のパスを残さない）と、読めないもの
    ['/srv/git/app.git', null], ['../app.git', null], ['file:///srv/git/app.git', null], ['C:/repos/app.git', null], ['', null], ['https://user:pass@', null],
  ]
  for (const [raw, expected] of cases) assert.equal(sanitizeRemote(raw), expected, raw)

  // 起票のときに、git の設定ファイルから読む（origin を優先。git コマンドは呼ばない）
  const t = makeEnv()
  for (const [url, expected] of [['https://deploy:s3cr3t@example.com/acme/app.git?token=zzz', 'https://example.com/acme/app.git'], ['/srv/git/app.git', 'null']]) {
    gitConfig(t, url)
    const id = /INC-\d{4}-\d{4}/.exec(note(t, [...ADD]).stdout)[0]
    const text = incidentText(t, id)
    assert.match(text, new RegExp(`^remote: ${expected.replace(/[.?/]/g, '\\$&')}$`, 'm'))
    assert.doesNotMatch(text, /s3cr3t|deploy|zzz|\/srv\/git/)
  }
  // リモートがなければ null
  const none = makeEnv()
  note(none, [...ADD])
  assert.match(incidentText(none, 'INC-2026-0001'), /^remote: null$/m)
})

test('incident add: すでにある失敗票は上書きしない。同時に起票しても、番号は重ならない', async () => {
  const t = makeEnv()
  // 番号の途中に、手で置いたファイルや、形の崩れたファイルがあっても、上書きしない
  writeFiles(join(t.user, 'incidents'), { 'INC-2026-0001.md': '手で書いた失敗票\n', 'INC-2026-0003.md': '---\nid: INC-2026-0003\n---\n', 'notes.md': 'メモ' })
  assert.match(note(t, [...ADD]).stdout, /INC-2026-0004/)
  assert.equal(incidentText(t, 'INC-2026-0001'), '手で書いた失敗票\n')
  assert.equal(incidentText(t, 'INC-2026-0003'), '---\nid: INC-2026-0003\n---\n')

  const runs = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
    execFile(process.execPath, [script('note.mjs'), ...ADD], { cwd: t.repo, env: t.env }, (error, stdout) => resolve(stdout))
  })))
  const ids = runs.map((out) => /INC-\d{4}-\d{4}/.exec(out)?.[0])
  assert.equal(new Set(ids).size, 8, ids.join(' '))
  assert.deepEqual(ids.slice().sort(), ['INC-2026-0005', 'INC-2026-0006', 'INC-2026-0007', 'INC-2026-0008', 'INC-2026-0009', 'INC-2026-0010', 'INC-2026-0011', 'INC-2026-0012'])
})

test('incident add --from-draft: 下書きの値（status、control、分類、試用を始めた日）を引き継ぐ', () => {
  const t = makeEnv({ config: { auto: { interval_days: 7 } } })
  startAuto(t, ['route-placement', 'flaky-e2e'])
  draft(t, 'route-placement', { extra: ['--severity', 'high', '--area', 'backend', '--signal', 'human_correction'] })
  note(t, ['trial', 'add', '--session', 'auto-1', '--key', 'route-placement', '--text', 'ルート定義は src/routes/ に置く'], { now: at(62) })
  note(t, ['pending', 'add', '--session', 'auto-1', '--key', 'flaky-e2e', '--root-cause', 'environment', '--asked', 'E2E を通して', '--expected', '通る', '--actual', 'たまに落ちる'], { now: at(63) })
  finishAuto(t)

  const issued = note(t, ['incident', 'add', '--from-draft', '--key', 'route-placement', '--session', 'human-1'], { now: at(0, 1) })
  assert.match(issued.stdout, /INC-2026-0001.*\n下書きは、起票したので捨てました。/)
  const text = incidentText(t, 'INC-2026-0001')
  // 自動改善が試用を入れたときに下書きへ書いた値を、そのまま引き継ぐ（open に戻さない）
  for (const line of ['status: trial', 'control: trial:rules/route-placement', 'applied_by: auto', 'trial_started_at: 2026-11-16', 'root_cause: knowledge', 'severity: high', 'area: backend', 'signal: human_correction', 'category: dev/mistake', 'date: 2026-11-17']) {
    assert.match(text, new RegExp(`^${line.replace(/[/]/g, '\\/')}$`, 'm'), line)
  }
  assert.match(text, /## 根拠\n\n- 改善候補 c-/)
  assert.equal(note(t, ['pending', 'show', 'route-placement']).status, 1)
  // 指定した値は、下書きの値より優先する
  const wontfix = note(t, ['incident', 'add', '--from-draft', '--key', 'flaky-e2e', '--status', 'wontfix', '--session', 'human-1'], { now: at(1, 1) })
  assert.match(wontfix.stdout, /INC-2026-0002/)
  assert.match(incidentText(t, 'INC-2026-0002'), /^status: wontfix$/m)
  assert.match(incidentText(t, 'INC-2026-0002'), /^root_cause: environment$/m)
  // 下書きがなければ、起票しない
  const missing = note(t, ['incident', 'add', '--from-draft', '--key', 'no-draft', '--session', 'human-1'])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /no-draft の下書きがありません/)
})

test('incident add / set: 項目を検査する。人だけの操作（自動改善のセッションと、その実行中は見送り）', () => {
  const t = makeEnv({ config: { auto: { interval_days: 7 } } })
  const bad = [
    ['incident', 'add', '--session', 'h', '--key', 'route-placement', '--asked', 'a', '--expected', 'b', '--actual', 'c'],
    [...ADD, '--status', 'done'],
    [...ADD, '--root-cause', 'laziness'],
    [...ADD, '--status', 'trial'],
    [...ADD.slice(0, -2)],
    ['incident', 'add', '--session', 'h', '--key', 'Bad Key', '--root-cause', 'knowledge', '--category', 'dev/mistake', '--asked', 'a', '--expected', 'b', '--actual', 'c'],
    ['incident', 'set', 'INC-1', '--status', 'trial'],
    ['incident', 'nope'],
  ]
  for (const args of bad) assert.equal(note(t, args).status, 1, args.join(' '))
  assert.equal(existsSync(join(t.user, 'incidents')) ? readdirSync(join(t.user, 'incidents')).filter((f) => f.endsWith('.md')).length : 0, 0)

  note(t, [...ADD])
  const set = note(t, ['incident', 'set', 'INC-2026-0001', '--status', 'converted', '--control', '.claude/rules/routes.md', '--session', 'human-1'])
  assert.match(set.stdout, /失敗票 INC-2026-0001 を更新しました（status: converted、control: \.claude\/rules\/routes\.md）/)
  const text = incidentText(t, 'INC-2026-0001')
  assert.match(text, /^status: converted$/m)
  assert.match(text, /^control: \.claude\/rules\/routes\.md$/m)
  assert.match(text, /## 何を頼んだか\n\nユーザー一覧の API を足す/)
  assert.equal(note(t, ['incident', 'set', 'INC-2026-0001', '--status', 'nope']).status, 1)
  // 別のリポジトリの票は、書き換えない
  const other = secondRepo(t, 'other-app')
  const foreign = note(other, ['incident', 'set', 'INC-2026-0001', '--status', 'retired', '--session', 'human-1'])
  assert.equal(foreign.status, 1)
  assert.match(foreign.stderr, /別のリポジトリ（demo-app）のものです/)

  // 自動改善のセッション（ロック中、ロックを外したあと）と、その実行中のほかのセッションからは、起票も更新もできない
  seedCandidates(t, 'second-key', ['s1', 's2'])
  note(t, ['lock', '--session', 'auto-1'], { now: at(60) })
  for (const session of ['auto-1', 'human-1']) {
    assert.match(note(t, [...ADD.slice(0, 2), '--session', session, ...ADD.slice(4)], { now: at(61) }).stdout, /^見送り：/, session)
    assert.match(note(t, ['incident', 'set', 'INC-2026-0001', '--status', 'retired', '--session', session], { now: at(61) }).stdout, /^見送り：/, session)
  }
  finishAuto(t)
  assert.match(note(t, [...ADD.slice(0, 2), '--session', 'auto-1', ...ADD.slice(4)], { now: at(70) }).stdout, /^見送り：このセッションは、自動改善/)
  assert.deepEqual(note(t, ['incident', 'list', '--all', '--json']).json.map((i) => [i.id, i.status]), [['INC-2026-0001', 'converted']])
  // 読むだけなら、自動改善のセッションからでも使える
  assert.equal(note(t, ['incident', 'list', '--session', 'auto-1']).status, 0)
})

test('incident import: 1.x の失敗票（harness/incidents/）を user 側へ取り込む。番号が重なれば振り直し、何度実行しても増えない', () => {
  const v1 = (id, key, extra = '') => `---\nid: ${id}\ndate: 2026-05-01\narea: backend\ncategory: dev/mistake\nsignal: human_correction\nroot_cause: knowledge\ncause_key: ${key}\nrelated: []\nseverity: normal\nstatus: trial\ncontrol: trial:rules/${key}\napplied_by: human\ntrial_started_at: 2026-05-01\npromoted_at: null\n${extra}---\n\n## 何を頼んだか\n\n${key} の依頼\n\n## 期待した結果\n\nA\n\n## 実際の結果\n\nB\n\n## 根拠\n\n- コミット：abc123\n`
  const t = makeEnv({
    files: {
      'harness/incidents/INC-2026-0001.md': v1('INC-2026-0001', 'route-placement'),
      'harness/incidents/INC-2026-0002.md': v1('INC-2026-0002', 'route-placement').replace('related: []', 'related: [INC-2026-0001]'),
      'harness/incidents/INC-2025-0007.md': v1('INC-2025-0007', 'migration-forgotten').replace('status: trial', 'status: converted').replace('control: trial:rules/migration-forgotten', 'control: harness/guards.json'),
      'harness/incidents/README.md': 'メモ',
      'harness/incidents/INC-2026-0009.md': '設定欄のないファイル\n',
    },
  })
  gitConfig(t, 'https://token@example.com/acme/demo-app.git')
  // ほかのリポジトリの票が、すでに INC-2026-0001 と 0003 を使っている
  const other = secondRepo(t, 'other-app')
  note(other, [...ADD])
  note(other, [...ADD])
  note(other, [...ADD])
  assert.equal(note(other, ['incident', 'list', '--json']).json.length, 3)
  // 取り込む前に、古い ID を指す試用ルールがある
  note(t, ['trial', 'add', '--session', 'human-1', '--key', 'route-placement', '--text', 'ルート定義は src/routes/ に置く', '--ref', 'INC-2026-0002'])

  const run = note(t, ['incident', 'import', '--session', 'human-1'])
  assert.equal(run.status, 1)
  // 空いている番号はそのまま。重なる番号は、その年の次の番号に振り直す
  // 取り込み元のリポジトリの名前を出す（他人のリポジトリの票が、user 全体の票に混ざっていないかを確かめられるように）
  assert.match(run.stdout, /失敗票を 3 件取り込みました（取り込み元：リポジトリ demo-app の harness\/incidents\/、取り込み先：~\/\.claude\/self-improve\/incidents）：INC-2025-0007、INC-2026-0001 → INC-2026-0004、INC-2026-0002 → INC-2026-0005/)
  assert.match(run.stdout, /試用ルール route-placement の失敗票 ID を INC-2026-0005 に付け替えました/)
  assert.match(run.stdout, /もとのファイル（harness\/incidents\/）は消していません/)
  assert.match(run.stderr, /harness\/incidents\/INC-2026-0009\.md を読めません/)
  const mine = note(t, ['incident', 'list', '--json']).json
  assert.deepEqual(mine.map((i) => [i.id, i.cause_key, i.status, i.control]), [
    ['INC-2025-0007', 'migration-forgotten', 'converted', 'harness/guards.json'],
    ['INC-2026-0004', 'route-placement', 'trial', 'trial:rules/route-placement'],
    ['INC-2026-0005', 'route-placement', 'trial', 'trial:rules/route-placement'],
  ])
  const text = incidentText(t, 'INC-2026-0005')
  for (const line of ['id: INC-2026-0005', 'date: 2026-05-01', 'repo: demo-app', `repo_id: ${repoId(t)}`, 'remote: https://example.com/acme/demo-app.git', 'area: backend', 'signal: human_correction', 'related: [INC-2026-0004]', 'trial_started_at: 2026-05-01', 'imported_from: INC-2026-0002']) {
    assert.match(text, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'), line)
  }
  assert.match(text, /## 何を頼んだか\n\nroute-placement の依頼\n\n## 期待した結果\n\nA\n\n## 実際の結果\n\nB\n\n## 根拠\n\n- コミット：abc123\n$/)
  assert.deepEqual(note(t, ['trial', 'list', '--json']).json.map((r) => r.ref), ['INC-2026-0005'])
  // ほかのリポジトリの票と、もとのファイルは、そのまま
  assert.match(incidentText(t, 'INC-2026-0001'), /^repo: other-app$/m)
  assert.equal(readdirSync(join(t.repo, 'harness/incidents')).length, 5)
  // check は、取り込んだ票と試用ルールの対応を問題にしない
  assert.deepEqual(note(t, ['incident', 'show', 'INC-2026-0004']).status, 0)

  // もう一度実行しても、増えない
  const again = note(t, ['incident', 'import', '--session', 'human-1'])
  assert.match(again.stdout, /取り込み済みなので飛ばしました（リポジトリ demo-app の harness\/incidents\/）：INC-2025-0007、INC-2026-0001、INC-2026-0002/)
  assert.equal(note(t, ['incident', 'list', '--all', '--json']).json.length, 6)
  // 人だけの操作。失敗票のないリポジトリでは、何もしない
  note(t, ['lock', '--session', 'auto-1'], { now: at(60) })
  assert.match(note(t, ['incident', 'import', '--session', 'auto-1'], { now: at(61) }).stdout, /^見送り：/)
  assert.match(note(other, ['incident', 'import', '--session', 'human-2']).stdout, /取り込む失敗票はありません（リポジトリ other-app の harness\/incidents\/ に/)
})
