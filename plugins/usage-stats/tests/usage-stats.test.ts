import { expect, test } from 'claude-code/testing'
import { addSession, addTurn, dateKey, emptyDay, formatNumber, heatmap, streak, summarize, usageTokens } from '../hooks/register.js'

const USAGE = { model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 800, cache_creation_input_tokens: 50 }
const today = new Date(2026, 9, 2) // 2026-10-02 (金)

function day(messages: number, sessions = ['s1']) {
  return { ...emptyDay(), sessions, messages }
}

test('dateKey uses local date', () => {
  expect(dateKey(today)).toBe('2026-10-02')
})

test('formats numbers', () => {
  expect(formatNumber(999)).toBe('999')
  expect(formatNumber(1500)).toBe('1.5k')
  expect(formatNumber(2_300_000)).toBe('2.3M')
})

test('addTurn counts main turns and all tokens', () => {
  let d = addTurn(emptyDay(), { usage: USAGE, isMain: true })
  d = addTurn(d, { usage: { ...USAGE, model: 'claude-haiku-4-5' }, isMain: false })
  expect(d.messages).toBe(1)
  expect(d.tokens).toBe(usageTokens(USAGE) * 2)
  expect(d.models['claude-opus-5-5']).toEqual({ turns: 1, tokens: 1000 })
  expect(d.models['claude-haiku-4-5']).toEqual({ turns: 0, tokens: 1000 })
})

test('addSession dedupes', () => {
  expect(addSession(addSession(emptyDay(), 'a'), 'a').sessions).toEqual(['a'])
})

test('streak counts back from today, or from yesterday when today is idle', () => {
  const days = { '2026-10-01': day(1), '2026-09-30': day(2), '2026-09-28': day(1) }
  expect(streak(days, today)).toBe(2)
  expect(streak({ ...days, '2026-10-02': day(1) }, today)).toBe(3)
})

test('summarize respects the range', () => {
  const days = {
    '2026-10-02': addTurn(day(0, ['a']), { usage: USAGE, isMain: true }),
    '2026-09-01': addTurn(day(0, ['b']), { usage: { ...USAGE, model: 'claude-sonnet-5' }, isMain: true }),
  }
  const all = summarize(days, today, Infinity)
  expect(all.sessions).toBe(2)
  expect(all.messages).toBe(2)
  expect(all.activeDays).toBe(2)
  const week = summarize(days, today, 7)
  expect(week.sessions).toBe(1)
  expect(week.favoriteModel).toBe('claude-opus-5-5')
})

test('heatmap ends on today and leaves the future empty', () => {
  const grid = heatmap({ '2026-10-02': day(4), '2026-10-01': day(1) }, today, 4)
  expect(grid.length).toBe(7)
  expect(grid[5][3]).toBe(4) // 金曜・最後の週
  expect(grid[4][3]).toBe(1)
  expect(grid[6][3]).toBe(null) // 土曜はまだ来ていない
})

function stubEngine(on) {
  const store = new Map()
  on('store.get', async ($, e) => ({ value: store.get(e.key) }))
  on('store.set', async ($, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.keys', async () => ({ value: [...store.keys()] }))
  on('session.id', async () => ({ value: 'session-1' }))
  on('command.register', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('turn.complete', async () => ({ text: '' }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('clock.now', async () => ({ value: today.getTime() + 12 * 3600_000 }))
}

const PANE_PROPS = { title: 'Usage stats', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} }

for (const surface of ['terminal', 'desktop'] as const) {
  test('pane shows the cards and heatmap on ' + surface, async ($, on) => {
    stubEngine(on)
    await $.session.start({ cwd: '/tmp' })
    await $.turn.complete({ answer: 'hi', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage: USAGE })
    await $.command.run({ command: 'stats', args: '' })
    const ui = await $.ui.mount({ plugin: 'usage-stats', surface, component: 'Pane', requestId: 'usage-stats', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'Total tokens' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'claude-opus-5-5' })).toBeDefined()
    await ui.press({ key: 'tab-models' })
    expect(await ui.find({ type: 'Text', text: /1 turns/ })).toBeDefined()
  })
}
