import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isHarnessNoteOnly, isNonChanging, parseBash, skeleton, writeTargets } from '../scripts/lib/bash.mjs'

const targets = (command) => writeTargets(command).flatMap((t) => t.tokens)

test('parseBash: 区切りごとに分け、引用を外し、リダイレクトを拾う', () => {
  const parsed = parseBash('cd src && git commit -m "fix: a && b" ; echo done > out.txt 2>&1 | tee -a log')
  assert.deepEqual(parsed.segments.map((s) => s.words.map((w) => w.text)), [
    ['cd', 'src'],
    ['git', 'commit', '-m', 'fix: a && b'],
    ['echo', 'done'],
    ['tee', '-a', 'log'],
  ])
  assert.deepEqual(parsed.segments[2].redirects, [{ op: '>', target: 'out.txt' }, { op: '>&', target: '1' }])
  assert.equal(skeleton(parsed.segments[1]), "git commit -m '…'")
  assert.equal(parsed.subst, false)
})

test('parseBash: bash -c と eval の中身、コマンド置換、ヒアドキュメントを扱う', () => {
  assert.ok(parseBash('bash -c "git push -f origin main"').segments.some((s) => skeleton(s) === 'git push -f origin main'))
  assert.ok(parseBash("eval 'rm -rf build'").segments.some((s) => skeleton(s) === 'rm -rf build'))
  assert.equal(parseBash('echo $(date)').subst, true)
  assert.equal(parseBash('echo `date`').subst, true)
  assert.equal(parseBash("echo '$(date)'").subst, false)
  const heredoc = parseBash("harness-note report write --body - <<'EOF'\n## 検討\n- a; b && c | d > e\nEOF")
  assert.equal(heredoc.segments.length, 1)
  assert.equal(heredoc.heredocUnsafe, false)
  assert.equal(parseBash('cat <<EOF\n$(rm -rf x)\nEOF').heredocUnsafe, true)
})

test('isNonChanging: 読むだけのコマンドと harness-note は「変更あり」に数えない', () => {
  for (const command of [
    'ls -la', 'cat a.txt | grep x | wc -l', 'git status && git diff --stat', 'git log --oneline -5', 'find . -name "*.ts"',
    'sed -n 1,10p file', 'harness-note keys', 'harness-note add --category dev/bug --key some-key --text "a b"',
    "harness-note report write --body - <<'EOF'\n本文 > と ; を含む\nEOF", 'echo hi 2>&1', 'grep -r foo . > /dev/null', 'git branch --show-current',
  ]) {
    assert.equal(isNonChanging(command), true, command)
  }
  for (const command of [
    'npm test', 'echo x > file', 'git commit -m x', 'git checkout -- a', 'sed -i s/a/b/ f', 'find . -name x -delete', 'rm a', 'touch a',
    'cat $(ls)', 'ls; rm a', 'tee out', 'git branch -D feature', 'python script.py', 'sort -o out in',
    'HARNESS_DATA_DIR=/tmp/x harness-note keys > out',
  ]) {
    assert.equal(isNonChanging(command), false, command)
  }
})

test('isHarnessNoteOnly: harness-note の単純な呼び出しだけを認める', () => {
  assert.equal(isHarnessNoteOnly('harness-note keys'), true)
  assert.equal(isHarnessNoteOnly('harness-note keys && harness-note list'), true)
  assert.equal(isHarnessNoteOnly('harness-note keys && rm -rf x'), false)
  assert.equal(isHarnessNoteOnly('HARNESS_DATA_DIR=/tmp/x harness-note keys'), false)
  assert.equal(isHarnessNoteOnly('harness-note keys > out.txt'), false)
  assert.equal(isHarnessNoteOnly('harness-note add --text "$(cat secret)"'), false)
  assert.equal(isHarnessNoteOnly('./harness-note keys'), false)
  assert.equal(isHarnessNoteOnly(''), false)
})

test('writeTargets: 書き換えると分かっているコマンドの引数と、リダイレクト先だけを拾う', () => {
  assert.deepEqual(targets('echo x >> .env'), ['.env'])
  assert.deepEqual(targets("sed -i 's/a/b/' harness/config.json"), ['s/a/b/', 'harness/config.json'])
  assert.deepEqual(targets('cp .env.example .env'), ['.env'])
  assert.deepEqual(targets('mv a b'), ['a', 'b'])
  assert.deepEqual(targets('sudo rm -f CLAUDE.md'), ['CLAUDE.md'])
  assert.deepEqual(targets('git checkout -- harness/guards.json'), ['harness/guards.json'])
  assert.deepEqual(targets('cat harness/config.json > /tmp/copy.json'), ['/tmp/copy.json'])
  assert.deepEqual(targets('dd if=a of=b'), ['b'])
  for (const command of ['cat .env', 'source .env && npm start', 'git add CLAUDE.md', 'git commit -m "x"', 'sed -n 1p .env', 'docker compose --env-file .env up', 'harness-note keys']) {
    assert.deepEqual(targets(command), [], command)
  }
})
