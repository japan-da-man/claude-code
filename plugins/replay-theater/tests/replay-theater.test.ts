import { expect, test } from 'claude-code/testing'
import { countChanges, diffLines, hintText, relPath, stepsFor, trimContext } from '../hooks/register.js'

test('diffLines finds the changed line with one line of context', () => {
  const before = ['1', '2', '3', '4', '5', '6', '7'].join('\n')
  const after = ['1', '2', '3', 'FOUR', '5', '6', '7'].join('\n')
  expect(diffLines(before, after)).toEqual([
    { op: ' ', t: '3' },
    { op: '-', t: '4' },
    { op: '+', t: 'FOUR' },
    { op: ' ', t: '5' },
  ])
})

test('trimContext marks skipped lines between changes', () => {
  const lines = ['a', 'B', 'c', 'd', 'e', 'F', 'g'].map((t) => ({ op: t === t.toUpperCase() ? '+' : ' ', t }))
  expect(trimContext(lines).map((l) => l.t)).toEqual(['a', 'B', 'c', '⋯', 'e', 'F', 'g'])
})

test('stepsFor turns each tool call into steps', () => {
  expect(stepsFor({ tool: 'Edit', file_path: '/repo/src/greet.js', old_string: 'greet', new_string: 'welcome', replace_all: true }, '/repo', null)).toEqual([
    { tool: 'Edit', file: 'src/greet.js', note: 'replace all', diff: [{ op: '-', t: 'greet' }, { op: '+', t: 'welcome' }] },
  ])
  const multi = stepsFor({ tool: 'MultiEdit', file_path: '/repo/a.js', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'p', new_string: 'q' }] }, '/repo', null)
  expect(multi.map((s) => s.note)).toEqual(['edit 1 of 2', 'edit 2 of 2'])
  expect(stepsFor({ tool: 'Write', file_path: '/repo/new.md', content: 'hi\n' }, '/repo', null)[0].note).toBe('new file')
  expect(stepsFor({ tool: 'Write', file_path: '/repo/old.md', content: 'hi\n' }, '/repo', 'bye\n')[0].note).toBe('rewrite')
})

test('helpers', () => {
  expect(relPath('/repo', '/repo/src/a.js')).toBe('src/a.js')
  expect(relPath('/repo', '/elsewhere/a.js')).toBe('/elsewhere/a.js')
  expect(countChanges([{ op: '+', t: '' }, { op: '-', t: '' }, { op: '+', t: '' }])).toEqual({ add: 2, del: 1 })
  expect(hintText(1)).toBe('▶ Replay: 1 edit (press r)')
  expect(hintText(5)).toBe('▶ Replay: 5 edits (press r)')
})

function stubEngine(on) {
  on('command.register', async () => ({ value: undefined }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('fs.exists', async () => ({ value: false }))
  on('clock.sleep', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.close', async () => ({ value: undefined }))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  // ツールは実行せず成功したことにする
  on('tool.call', async () => ({ result: { ok: true } }))
  on('ui.render', async ($, e) => $.ui.resolve(e).Box({ children: [] }))
}

const TURN = { answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as const

async function runTurn($) {
  await $.turn.start({ turnId: 't1', prompt: 'rename' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/greet.js', old_string: 'export function greet(name) {', new_string: 'export function welcome(name) {' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/README.md' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/NOTES.md', content: 'hello\nworld\n' })
  await $.turn.complete({ ...TURN, turnId: 't1' })
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
    expect(await pane.find({ type: 'Text', text: 'Write · new file' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '+ world' })).toBeDefined()

    // 最後より先には進まない
    await pane.press({ key: 'next' })
    expect(await pane.find({ type: 'Text', text: 'step 2 of 2' })).toBeDefined()
    await pane.press({ key: 'prev' })
    expect(await pane.find({ type: 'Text', text: 'step 1 of 2' })).toBeDefined()
  })
}

test('a turn without edits keeps the last replay', async ($, on) => {
  stubEngine(on)
  await $.session.start({ cwd: '/repo' })
  await runTurn($)
  await $.turn.start({ turnId: 't2', prompt: 'thanks' })
  await $.turn.complete({ ...TURN, turnId: 't2' })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: '▶ Replay: 2 edits (press r)' })).toBeDefined()
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

test('/replay with nothing recorded says so', async ($, on) => {
  stubEngine(on)
  await $.session.start({ cwd: '/repo' })
  const r = await $.command.run({ command: 'replay', args: '' })
  expect(r.text).toBe('Replay Theater: no edits in the last turn.')
})
