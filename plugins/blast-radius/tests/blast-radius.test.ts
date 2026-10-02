import { expect, test } from 'claude-code/testing'
import { detectRisks, formatBytes, parseFindDelete, segments, worst } from '../hooks/register.js'

test('segments split on operators and respect quotes', () => {
  expect(segments(`cd app && rm -rf "build dir"; echo 'a && b' | cat`)).toEqual([
    ['cd', 'app'],
    ['rm', '-rf', 'build dir'],
    ['echo', 'a && b'],
    ['cat'],
  ])
})

test('detects recursive rm and tracks cd', () => {
  expect(detectRisks('cd app && sudo rm -rf dist node_modules')).toEqual([
    { kind: 'rm', cwd: 'app', targets: ['dist', 'node_modules'], force: true },
  ])
  expect(detectRisks('rm -r -- -weird')).toEqual([{ kind: 'rm', cwd: null, targets: ['-weird'], force: false }])
  expect(detectRisks('rm file.txt')).toEqual([])
})

test('detects risky git commands', () => {
  expect(detectRisks('git reset --hard origin/main')).toEqual([{ kind: 'reset-hard', cwd: null, ref: 'origin/main' }])
  expect(detectRisks('git -C repo push -f origin feature')).toEqual([
    { kind: 'force-push', cwd: 'repo', remote: 'origin', src: 'feature', dst: 'feature' },
  ])
  expect(detectRisks('git push origin +main:release')[0]).toEqual({ kind: 'force-push', cwd: null, remote: 'origin', src: 'main', dst: 'release' })
  expect(detectRisks('git push --force-with-lease')[0].kind).toBe('force-push')
  expect(detectRisks('git clean -fdx')).toEqual([{ kind: 'clean', cwd: null, flags: ['d', 'x'], paths: [] }])
  expect(detectRisks('git checkout -- .')).toEqual([{ kind: 'discard', cwd: null, paths: ['.'] }])
  expect(detectRisks('git restore src/a.ts')).toEqual([{ kind: 'discard', cwd: null, paths: ['src/a.ts'] }])
  expect(detectRisks('git branch -D old')).toEqual([{ kind: 'branch-delete', cwd: null, branches: ['old'] }])
  expect(detectRisks('git stash clear')[0].kind).toBe('stash-drop')
})

test('looks inside bash -c, sh -c and eval', () => {
  expect(detectRisks(`bash -c 'cd app && rm -rf dist'`)).toEqual([{ kind: 'rm', cwd: 'app', targets: ['dist'], force: true }])
  expect(detectRisks(`cd repo && sh -lc "git reset --hard"`)).toEqual([{ kind: 'reset-hard', cwd: 'repo', ref: 'HEAD' }])
  expect(detectRisks(`eval "rm -r build"`)[0]).toEqual({ kind: 'rm', cwd: null, targets: ['build'], force: false })
  expect(detectRisks(`bash -c "bash -c 'git clean -fd'"`)[0].kind).toBe('clean')
  // 中身が安全なら何もしない
  expect(detectRisks(`bash -c 'cd frontend && npm run build'`)).toEqual([])
  expect(detectRisks(`sudo bash -c 'echo "127.0.0.1 app.test" >> /etc/hosts'`)).toEqual([])
})

test('detects find -delete and find -exec rm', () => {
  expect(detectRisks('find . -name "*.log" -delete')).toEqual([
    { kind: 'find-delete', cwd: null, dryRun: ['.', '-name', '*.log'], isUnfiltered: false, via: '-delete' },
  ])
  expect(detectRisks('find build -type f -exec rm -f {} +')[0]).toEqual({
    kind: 'find-delete',
    cwd: null,
    dryRun: ['build', '-type', 'f'],
    isUnfiltered: false,
    via: '-exec rm',
  })
  expect(detectRisks('find . -name x -exec rm {} \\;')[0].dryRun).toEqual(['.', '-name', 'x'])
  // -delete が条件より前だと全部消える
  expect(parseFindDelete(['.', '-delete', '-name', '*.log']).isUnfiltered).toBe(true)
  expect(parseFindDelete(['.', '-maxdepth', '1', '-delete']).isUnfiltered).toBe(true)
  // 下見でファイルに書き出す動作は外す
  expect(parseFindDelete(['.', '-fprint', 'out.txt', '-delete']).dryRun).toEqual(['.'])
  // 削除しない find は対象外
  expect(detectRisks('find . -name "*.ts" -exec grep -l foo {} +')).toEqual([])
})

test('detects xargs rm', () => {
  expect(detectRisks('git ls-files -o | xargs rm -f')).toEqual([{ kind: 'xargs-rm', cwd: null }])
  expect(detectRisks('cat list.txt | xargs -n 1 -I{} rm {}')).toEqual([{ kind: 'xargs-rm', cwd: null }])
  expect(detectRisks('ls | xargs echo')).toEqual([])
})

test('leaves safe commands alone', () => {
  for (const command of ['git push origin main', 'git reset HEAD~1', 'git checkout main', 'git restore --staged a', 'git clean -n', 'ls -la']) {
    expect(detectRisks(command)).toEqual([])
  }
})

test('helpers', () => {
  expect(formatBytes(2048)).toBe('2.0 KB')
  expect(worst([{ severity: 'low' }, { severity: 'critical' }, { severity: 'high' }])).toBe('critical')
})

// git の出力を決め打ちで返し、Bash は実行しない
function stubEngine(on, { answer, diffStat, failCwd = false }) {
  const asked = []
  on('session.cwd', async () => {
    if (failCwd) throw new Error('boom')
    return { value: '/repo' }
  })
  on('session.surfaces', async () => ({ value: ['terminal'] }))
  on('env.get', async () => ({ value: '/home/me' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.close', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  // $.ui.ask は質問ダイアログ（AskUserQuestion ツール）の呼び出しとして届く
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
    asked.push(e)
    return { result: { questions: e.questions, answers: { [e.questions[0].question]: answer } } }
  })
  on('process.run', async ($, e) => {
    const argv = e.argv.join(' ')
    if (argv.startsWith('git diff --stat')) return { value: { exitCode: 0, stdout: diffStat, stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('tool.call', { tool: 'Bash' }, async () => ({ result: 'ran' }))
  return asked
}

const DIFF = ' src/a.ts | 4 ++--\n src/b.ts | 2 +-\n 2 files changed, 3 insertions(+), 3 deletions(-)\n'

test('blocks git reset --hard when the user says stop', async ($, on) => {
  const asked = stubEngine(on, { answer: '止める', diffStat: DIFF })
  const r = await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
  expect(asked.length).toBe(1)
  expect(r.deny).toMatch(/止めました/)
  const ui = await $.ui.mount({ plugin: 'blast-radius', surface: 'desktop', component: 'Pane', requestId: 'blast-radius', props: { title: '', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  expect(await ui.find({ type: 'Text', text: /2 ファイル分が消える/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'src/a.ts | 4 ++--' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '止めた' })).toBeDefined()
})

test('runs the command when the user says go', async ($, on) => {
  stubEngine(on, { answer: '実行する', diffStat: DIFF })
  const r = await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
  expect(r.result).toBe('ran')
})

test('does not ask when nothing would be lost', async ($, on) => {
  const asked = stubEngine(on, { answer: '止める', diffStat: '' })
  const r = await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
  expect(asked.length).toBe(0)
  expect(r.result).toBe('ran')
})

test('passes safe commands straight through', async ($, on) => {
  const asked = stubEngine(on, { answer: '止める', diffStat: DIFF })
  const r = await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(asked.length).toBe(0)
  expect(r.result).toBe('ran')
})

test('blocks the command when checking it fails', async ($, on) => {
  // 影響範囲を調べる途中で失敗させる
  stubEngine(on, { answer: '実行する', diffStat: DIFF, failCwd: true })
  const r = await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
  expect(r.deny).toMatch(/念のため止めました/)
})

const PANE = { plugin: 'blast-radius', component: 'Pane', requestId: 'blast-radius', props: { title: '', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const

for (const surface of ['terminal', 'desktop'] as const) {
  test('rm -rf card lists every file on ' + surface, async ($, on) => {
    stubEngine(on, { answer: '止める', diffStat: '' })
    on('fs.exists', async () => ({ value: true }))
    on('fs.stat', async ($, e) => ({ value: { kind: 'dir', size: 0 } }))
    on('fs.list', async ($, e) =>
      e.path === '/repo/build'
        ? { value: [{ name: 'index.html', kind: 'file', size: 1024, isLink: false }, { name: 'assets', kind: 'dir', size: 0, isLink: false }] }
        : { value: [{ name: 'app.js', kind: 'file', size: 2048, isLink: false }] },
    )
    const r = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
    expect(r.deny).toMatch(/2 個のファイル（3.0 KB）を削除/)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Blast Radius · rm -rf/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'build/index.html' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'build/assets/app.js' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Paths: build' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '止めた' })).toBeDefined()
  })
}
