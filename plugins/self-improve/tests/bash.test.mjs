import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isHarnessNoteOnly, isNonChanging, parseBash, skeleton, substEnd, writeTargets } from '../scripts/lib/bash.mjs'
import { SNEAKY_WRITES, bashAtLeast, bashVersion } from './helpers.mjs'

const targets = (command) => writeTargets(command).flatMap((t) => t.tokens)

test('parseBash: 区切りごとに分け、引用を外し、リダイレクトを拾う', () => {
  const parsed = parseBash('cd src && git commit -m "fix: a && b" ; echo done > out.txt 2>&1 | tee -a log')
  assert.deepEqual(parsed.segments.map((s) => s.words.map((w) => w.text)), [
    ['cd', 'src'],
    ['git', 'commit', '-m', 'fix: a && b'],
    ['echo', 'done'],
    ['tee', '-a', 'log'],
  ])
  assert.deepEqual(parsed.segments[2].redirects.map((r) => [r.op, r.target]), [['>', 'out.txt'], ['>&', '1']])
  assert.equal(skeleton(parsed.segments[1]), "git commit -m '…'")
  assert.deepEqual([parsed.subst, parsed.uncertain], [false, false])
})

test('parseBash: bash -c と eval の中身、コマンド置換、ヒアドキュメントを扱う', () => {
  assert.ok(parseBash('bash -c "git push -f origin main"').segments.some((s) => skeleton(s) === 'git push -f origin main'))
  assert.ok(parseBash("eval 'rm -rf build'").segments.some((s) => skeleton(s) === 'rm -rf build'))
  assert.equal(parseBash('echo $(date)').subst, true)
  assert.equal(parseBash('echo `date`').subst, true)
  assert.equal(parseBash('echo "$(date)"').subst, true)
  assert.equal(parseBash("echo '$(date)'").subst, false)
  // 区切りを引用したヒアドキュメントの本文は、そのまま読み飛ばす
  const heredoc = parseBash("harness-note report write --body - <<'EOF'\n## 検討\n- a; b && c | d > e $(x)\nEOF\nharness-note unlock")
  assert.deepEqual(heredoc.segments.map((s) => s.words.map((w) => w.text).join(' ')), ['harness-note report write --body -', 'harness-note unlock'])
  assert.deepEqual([heredoc.subst, heredoc.uncertain], [false, false])
  const tabbed = parseBash("cat <<-'EOF'\n\tbody\n\tEOF\necho after")
  assert.deepEqual([tabbed.segments.length, tabbed.uncertain], [2, false])
  // ヒアストリングは 1 語の入力
  assert.equal(parseBash('cat <<< "<<EOF"\ntouch x').segments.length, 2)
})

test('parseBash: 読み取りに自信のない書き方には印を付ける（呼び出し側が拒否の側に倒す）', () => {
  const uncertain = [
    'cat <<E-O-F\nx\nE-O-F\ntouch out.txt', // 区切りが単純でない
    'cat <<EOF\nnever ends', // 終わりが見つからない
    'cat <<EOF', // 本文がない
    'cat <<EOF\n$(rm x)\nEOF', // 引用していない区切りで、本文に展開がある
    "echo $'\\'' ; touch x ; echo $'\\''", // $'…'
    'echo ${x@P}', 'echo ${x:-$(rm y)}', 'echo ${!x}', 'echo "${x@P}"', // 単純でない展開
    'echo "unterminated', "echo 'unterminated",
  ]
  for (const command of uncertain) assert.equal(parseBash(command).uncertain, true, command)
  for (const command of ['echo $HOME', 'echo ${HOME}', 'echo "${USER} $1"', 'cat <<EOF\nplain text\nEOF', "cat <<'EOF'\n$(x) ${y@P}\nEOF", 'echo "a << b"']) {
    assert.equal(parseBash(command).uncertain, false, command)
  }
  // 引用の中の <<EOF は、ヒアドキュメントではない。次の行はコマンドとして読む
  assert.deepEqual(parseBash('echo "<<EOF"\ngit push --force origin main').segments.map(skeleton), ['echo <<EOF', 'git push --force origin main'])
  // 語が展開を含むかどうかも分かる
  const words = parseBash('harness-note add --text "$X" --key \'$Y\' plain').segments[0].words
  assert.deepEqual(words.map((w) => w.expands), [false, false, false, true, false, false, false])
})

test('parseBash: コマンド置換は、引用の中のものも中身を読む。置換を含む語は 1 つのまま残り、もとのコマンドは分かれない', () => {
  const read = (command) => {
    const parsed = parseBash(command)
    return [parsed.segments.map(skeleton), parsed.subst, parsed.uncertain]
  }
  // Claude Code の標準のコミットの形。ヒアドキュメントの本文に括弧や引用があっても、終わりを取り違えない
  const commit = 'git commit -m "$(cat <<\'EOF\'\nfix: route (placement) "quoted" $HOME `x`\n\nCo-Authored-By: X <x@example.com>\nEOF\n)" && git log -n 3'
  assert.deepEqual(read(commit), [['git commit -m $(…)', 'git log -n 3', 'cat'], true, false])
  assert.deepEqual(read('git commit -m $(cat msg.txt) -n'), [['git commit -m $(…) -n', 'cat msg.txt'], true, false])
  assert.deepEqual(read('echo "`git push --force`" && ls'), [['echo $(…)', 'ls', 'git push --force'], true, false])
  assert.deepEqual(read('echo $(echo "$(git push -f)") x'), [['echo $(…) x', 'echo $(…)', 'git push -f'], true, false])
  assert.deepEqual(read('a=$(printf "%s)" x); echo "$a"'), [['a=$(…)', 'echo $a', "printf '…' x".replace("'…'", '%s)')], true, false])
  // 終わりの見つからない置換と、括弧の数が合わない書き方（case）は、自信がないものとして扱う
  assert.equal(parseBash('echo "$(unterminated').uncertain, true)
  assert.equal(parseBash('echo `unterminated').uncertain, true)
  assert.equal(parseBash('echo $(case x in a) echo 1;; esac)').uncertain, true)
  // 閉じ括弧に見える文字が、ヒアドキュメントの本文・引用・エスケープ・コメントの中にあっても、数えない
  for (const text of ['cat <<EOF\n)\nEOF\n) tail', 'echo ")" \')\' \\) # )\n) tail', 'echo $(echo ")") `echo \\)`) tail']) {
    assert.equal(substEnd(text, 0), text.lastIndexOf(') tail'), text)
  }
  assert.equal(substEnd('no end', 0), -1)
})

test('isNonChanging: 読むだけと分かっているコマンドと harness-note だけを「変更あり」に数えない', () => {
  for (const command of [
    'ls -la', 'cat a.txt | grep x | wc -l', 'git status && git diff --stat', 'git log --oneline -5',
    'harness-note keys', 'harness-note add --category dev/bug --key some-key --text "a b"',
    "harness-note report write --body - <<'EOF'\n本文 > と ; を含む\nEOF", 'echo hi 2>&1', 'grep -r foo . > /dev/null', 'git branch --show-current',
    'git remote -v', 'git -C ../other status',
  ]) {
    assert.equal(isNonChanging(command), true, command)
  }
  for (const command of [
    'npm test', 'echo x > file', 'git commit -m x', 'git checkout -- a', 'sed -i s/a/b/ f', 'find . -name x -delete', 'rm a', 'touch a',
    'cat $(ls)', 'ls; rm a', 'tee out', 'git branch -D feature', 'python script.py', 'sort -o out in',
    'HARNESS_DATA_DIR=/tmp/x harness-note keys > out', 'FOO=1 ls', 'x=1', 'git stash list --all extra',
  ]) {
    assert.equal(isNonChanging(command), false, command)
  }
})

test('「読むだけ」に見えて書けるコマンドは、読むだけとも harness-note とも見なさない', () => {
  for (const [name, command] of SNEAKY_WRITES) {
    assert.equal(isNonChanging(command), false, name)
    assert.equal(isHarnessNoteOnly(command), false, name)
  }
})

test('レビューの表のコマンドは、実際に bash で実行するとファイルができる（判定の対象が本物であることの確かめ）', (ctx) => {
  if (!bashVersion()) return ctx.skip('bash がない')
  const works = ['echo x | uniq - out.txt', 'echo "<<EOF"\ntouch out.txt', 'cat <<E-O-F\nx\nE-O-F\ntouch out.txt', "echo $'\\'' ; touch out.txt ; echo $'\\''"]
  // ${x@P} は bash 4.4 から。古い bash（macOS の 3.2 など）では、構文エラーになるので確かめない。
  if (bashAtLeast(4, 4)) works.push("x='$(touch out.txt)'; echo ${x@P}")
  for (const command of works) {
    const dir = mkdtempSync(join(tmpdir(), 'self-improve-bash-'))
    spawnSync('bash', ['-c', command], { cwd: dir, encoding: 'utf8' })
    assert.equal(existsSync(join(dir, 'out.txt')), true, command)
  }
})

test('isHarnessNoteOnly: harness-note の単純な呼び出しだけを認める', () => {
  assert.equal(isHarnessNoteOnly('harness-note keys'), true)
  assert.equal(isHarnessNoteOnly('harness-note keys && harness-note list'), true)
  assert.equal(isHarnessNoteOnly('harness-note keys 2>/dev/null'), true)
  assert.equal(isHarnessNoteOnly('harness-note keys && rm -rf x'), false)
  assert.equal(isHarnessNoteOnly('HARNESS_DATA_DIR=/tmp/x harness-note keys'), false)
  assert.equal(isHarnessNoteOnly('harness-note keys > out.txt'), false)
  assert.equal(isHarnessNoteOnly('harness-note add --text "$(cat secret)"'), false)
  assert.equal(isHarnessNoteOnly('./harness-note keys'), false)
  assert.equal(isHarnessNoteOnly("harness-note add --text $'x'"), false)
  assert.equal(isHarnessNoteOnly('harness-note report write --body - <<EOF\n$(touch x)\nEOF'), false)
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
  assert.deepEqual(targets("cat > harness/config.json <<'EOF'\n{}\nEOF"), ['harness/config.json'])
  for (const command of ['cat .env', 'source .env && npm start', 'git add CLAUDE.md', 'git commit -m "x"', 'sed -n 1p .env', 'docker compose --env-file .env up', 'harness-note keys', 'chmod 600 .env']) {
    assert.deepEqual(targets(command), [], command)
  }
})
