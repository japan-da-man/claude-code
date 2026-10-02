import { expect, test } from 'claude-code/testing'
import { classify, parseFindDelete, splitSegments } from '../hooks/register.js'

test('splitSegments splits outside quotes only', () => {
  expect(splitSegments(`cd app && rm -rf "a && b"; echo 'x | y' | cat`)).toEqual(['cd app ', ' rm -rf "a && b"', " echo 'x | y' ", ' cat'])
})

test('official rules: rm, git and migrations, following cd', () => {
  expect(classify('cd app && rm -rf dist')).toMatchObject({ kind: 'rm', label: 'rm -rf', targets: ['dist'], dir: 'app' })
  expect(classify('rm -f a.txt')).toMatchObject({ kind: 'rm', targets: ['a.txt'] })
  expect(classify('rm a.txt')).toBe(null)
  expect(classify('git -C repo reset --hard')).toMatchObject({ kind: 'git-reset', dir: 'repo' })
  expect(classify('git push -f origin main')).toMatchObject({ kind: 'git-push-force' })
  expect(classify('git clean -fdx')).toMatchObject({ kind: 'git-clean' })
  expect(classify('git checkout -- .')).toMatchObject({ kind: 'git-checkout' })
  expect(classify('python manage.py migrate')).toMatchObject({ kind: 'migrate', tool: 'django' })
  // ( ... ) の中の cd は外に持ち越さない
  expect(classify('(cd sub && make) && rm -rf out')).toMatchObject({ kind: 'rm', dir: null })
})

test('looks inside bash -c, sh -c and eval', () => {
  expect(classify(`bash -c 'cd app && rm -rf dist'`)).toMatchObject({ kind: 'rm', targets: ['dist'], dir: 'app' })
  expect(classify(`cd repo && sh -lc "git reset --hard"`)).toMatchObject({ kind: 'git-reset', dir: 'repo' })
  expect(classify(`eval "rm -r build"`)).toMatchObject({ kind: 'rm', targets: ['build'] })
  expect(classify(`bash -c 'npm run build'`)).toBe(null)
  expect(classify(`sudo bash -c 'echo "127.0.0.1 app.test" >> /etc/hosts'`)).toBe(null)
})

test('find -delete, find -exec rm and xargs rm', () => {
  expect(classify('find . -name "*.log" -delete')).toMatchObject({ kind: 'find-delete', args: ['.', '-name', '*.log'], isUnfiltered: false })
  expect(classify('find build -type f -exec rm -f {} +')).toMatchObject({ kind: 'find-delete', label: 'find -exec rm', args: ['build', '-type', 'f'] })
  expect(parseFindDelete(['.', '-delete', '-name', 'x']).isUnfiltered).toBe(true)
  expect(parseFindDelete(['.', '-maxdepth', '1', '-delete']).isUnfiltered).toBe(true)
  expect(parseFindDelete(['.', '-fprint', 'out.txt', '-delete']).dryRun).toEqual(['.'])
  expect(classify('find . -name "*.ts" -exec grep -l foo {} +')).toBe(null)
  expect(classify('git ls-files -o | xargs rm -f')).toMatchObject({ kind: 'xargs-rm' })
  expect(classify('ls | xargs echo')).toBe(null)
})

test('more git: branch -D, stash, checkout and restore of paths', () => {
  expect(classify('git branch -D old')).toMatchObject({ kind: 'git-branch-delete', branches: ['old'] })
  expect(classify('git stash clear')).toMatchObject({ kind: 'git-stash', action: 'clear' })
  expect(classify('git restore src/a.ts')).toMatchObject({ kind: 'git-checkout', paths: ['src/a.ts'] })
  expect(classify('git checkout -- src/a.ts')).toMatchObject({ kind: 'git-checkout', paths: ['src/a.ts'] })
  expect(classify('git restore --staged a.ts')).toBe(null)
  expect(classify('git checkout main')).toBe(null)
})

// git の出力を決め打ちで返し、Bash は実行しない
function stubEngine(engine, on, { surfaces = ['terminal'], status = ' M src/a.ts\n M src/b.ts\n', press = 'proceed' } = {}) {
  const ran = []
  on('session.cwd', async () => ({ value: '/repo' }))
  on('session.surfaces', async () => ({ value: surfaces }))
  on('clock.now', async () => ({ value: Date.now() }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.close', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('process.run', async ($, e) => {
    const argv = e.argv.join(' ')
    if (argv.startsWith('sleep')) {
      // 待っている間に、ペインのボタンが押されたことにする
      if (press) {
        const ui = await engine.ui.mount({ ...PANE, surface: 'terminal' })
        await ui.press({ key: press })
      }
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    if (argv.startsWith('git status')) return { value: { exitCode: 0, stdout: status, stderr: '' } }
    if (argv.startsWith('git diff --shortstat')) return { value: { exitCode: 0, stdout: ' 2 files changed\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('tool.call', { tool: 'Bash' }, async ($, e) => (ran.push(e.command), { result: 'ran' }))
  return ran
}

test('Proceed runs the command', async ($, on) => {
  const ran = stubEngine($, on, { press: 'proceed' })
  const r = await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
  expect(r.result).toBe('ran')
  expect(ran).toEqual(['git reset --hard'])
})

test('Cancel refuses it with the summary', async ($, on) => {
  const ran = stubEngine($, on, { press: 'cancel' })
  const r = await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
  expect(r.deny).toMatch(/the user pressed Cancel/)
  expect(r.deny).toMatch(/discard uncommitted changes in 2 files/)
  expect(ran).toEqual([])
})

test('a session with no one to answer refuses at once', async ($, on) => {
  const ran = stubEngine($, on, { surfaces: [], press: null })
  const r = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(r.deny).toMatch(/no one to answer/)
  expect(ran).toEqual([])
})

test('safe commands run without a hold', async ($, on) => {
  const ran = stubEngine($, on, { press: null })
  const r = await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(r.result).toBe('ran')
  expect(ran).toEqual(['git status'])
})

const PANE = { plugin: 'blast-radius', component: 'Pane', requestId: 'blast-radius', props: { title: '', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

for (const surface of ['terminal', 'desktop'] as const) {
  test('the pane shows the report on ' + surface, async ($, on) => {
    let seen = null
    // 1 回目の待ちでペインを描いて中身を確かめ、そのあと Cancel を押す（先に登録したフックが先に答える）
    on('process.run', { argv: ['sleep', '0.25'] }, async () => {
      if (seen === null) {
        const ui = await $.ui.mount({ ...PANE, surface })
        seen = {
          title: await ui.find({ type: 'Text', text: /Blast Radius · git reset --hard/ }),
          would: await ui.find({ type: 'Text', text: /discard uncommitted changes in 2 files/ }),
          file: await ui.find({ type: 'Text', text: /M src\/a\.ts/ }),
          waiting: await ui.find({ type: 'Text', text: 'Claude is waiting on your answer' }),
        }
        await ui.press({ key: 'cancel' })
      }
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    })
    stubEngine($, on, { press: null })
    await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
    expect(seen.title).toBeDefined()
    expect(seen.would).toBeDefined()
    expect(seen.file).toBeDefined()
    expect(seen.waiting).toBeDefined()
  })
}
