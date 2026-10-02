import { expect, test } from 'claude-code/testing'
import { diffLines, makeEdit, relative, withContext } from '../hooks/register.js'

test('diffLines finds the changed line', () => {
  expect(diffLines('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
    { kind: 'ctx', text: 'a' },
    { kind: 'del', text: 'b' },
    { kind: 'add', text: 'B' },
    { kind: 'ctx', text: 'c' },
  ])
  expect(diffLines('', 'x\ny')).toEqual([
    { kind: 'add', text: 'x' },
    { kind: 'add', text: 'y' },
  ])
})

test('withContext keeps two lines around changes', () => {
  const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n')
  const after = ['1', '2', '3', '4', 'FIVE', '6', '7', '8', '9'].join('\n')
  const kept = withContext(diffLines(before, after))
  expect(kept.map((l) => l.text)).toEqual(['3', '4', '5', 'FIVE', '6', '7'])
  // 離れた 2 か所の変更の間には gap が入る
  const two = withContext(diffLines(before, before.replace('2', 'TWO').replace('8', 'EIGHT')))
  expect(two.map((l) => l.text)).toEqual(['1', '2', 'TWO', '3', '4', '…', '6', '7', '8', 'EIGHT', '9'])
})

test('makeEdit counts added and removed lines', () => {
  const edit = makeEdit('src/greet.js', 'Edit', 'export function greet(name) {', 'export function welcome(name) {')
  expect(edit).toMatchObject({ path: 'src/greet.js', tool: 'Edit', added: 1, removed: 1 })
})

test('relative strips the session folder', () => {
  expect(relative('/repo/src/a.js', '/repo')).toBe('src/a.js')
  expect(relative('/elsewhere/a.js', '/repo')).toBe('/elsewhere/a.js')
})

function stubEngine(on) {
  on('command.register', async () => ({ value: undefined }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('fs.exists', async () => ({ value: false }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.close', async () => ({ value: undefined }))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  // ツールは実行せず成功したことにする
  on('tool.call', async () => ({ result: { ok: true } }))
  on('ui.render', async ($, e) => $.ui.resolve(e).Box({ children: [] }))
}

async function runTurn($) {
  await $.turn.start({ turnId: 't1', prompt: 'rename' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/greet.js', old_string: 'export function greet(name) {', new_string: 'export function welcome(name) {' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/README.md' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/NOTES.md', content: 'hello\nworld\n' })
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
}

const BAND = { plugin: 'replay-theater', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const
const PANE = { plugin: 'replay-theater', component: 'Pane', requestId: 'replay-theater', props: { title: 'Replay Theater', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

for (const surface of ['terminal', 'desktop'] as const) {
  test('records the turn and steps through it on ' + surface, async ($, on) => {
    stubEngine(on)
    await $.session.start({ cwd: '/repo' })
    await runTurn($)

    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: '▶ Replay: 2 edits (press r)' })).toBeDefined()

    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: 'step 1 of 2' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'src/greet.js' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '- export function greet(name) {' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '+ export function welcome(name) {' })).toBeDefined()

    await pane.press({ key: 'next' })
    expect(await pane.find({ type: 'Text', text: 'step 2 of 2' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'NOTES.md' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '+ world' })).toBeDefined()

    // 最後より先には進まない
    await pane.press({ key: 'next' })
    expect(await pane.find({ type: 'Text', text: 'step 2 of 2' })).toBeDefined()
    await pane.press({ key: 'prev' })
    expect(await pane.find({ type: 'Text', text: 'step 1 of 2' })).toBeDefined()
  })
}

test('a turn without edits clears the band', async ($, on) => {
  stubEngine(on)
  await $.session.start({ cwd: '/repo' })
  await runTurn($)
  await $.turn.start({ turnId: 't2', prompt: 'thanks' })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /Replay:/ })).toBeUndefined()
})

test('failed edits are not recorded', async ($, on) => {
  // 先に登録したフックが先に答える
  on('tool.call', { tool: 'Edit' }, async () => ({ deny: 'nope' }))
  stubEngine(on)
  await $.session.start({ cwd: '/repo' })
  await runTurn($)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: 'step 1 of 1' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'NOTES.md' })).toBeDefined()
})
