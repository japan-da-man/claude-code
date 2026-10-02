import { expect, test } from 'claude-code/testing'
import { detectRisks, formatBytes, segments, worst } from '../hooks/register.js'

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
function stubEngine(on, { answer, diffStat }) {
  const asked = []
  on('session.cwd', async () => ({ value: '/repo' }))
  on('session.surfaces', async () => ({ value: ['terminal'] }))
  on('env.get', async () => ({ value: '/home/me' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.log', async () => ({ value: undefined }))
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
