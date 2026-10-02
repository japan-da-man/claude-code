import { expect, test } from 'claude-code/testing'
import { addReading, chart, forecastFor, short, trendWord } from '../hooks/register.js'

const r = (tokens: number, window = 200000) => ({ tokens, window, percent: Math.round((tokens / window) * 100) })

test('forecast bands match the official mod', () => {
  expect(forecastFor(0).word).toBe('Clear')
  expect(forecastFor(18).word).toBe('Clear')
  expect(forecastFor(25).word).toBe('Cloudy')
  expect(forecastFor(67).word).toBe('Showers')
  expect(forecastFor(81).word).toBe('Storm')
  expect(forecastFor(90).word).toBe('Compact soon')
})

test('short keeps one decimal', () => {
  expect(short(36100)).toBe('36.1k')
  expect(short(200000)).toBe('200k')
  expect(short(1000000)).toBe('1M')
  expect(short(999)).toBe('999')
})

test('trendWord says how much the last turn added or removed', () => {
  expect(trendWord([r(36100)])).toBe('')
  expect(trendWord([r(36100), r(134400)])).toBe('▲ +98.3k last turn')
  expect(trendWord([r(134400), r(40000)])).toBe('▼ 94.4k last turn')
  expect(trendWord([r(40000), r(40000)])).toBe('steady')
})

test('chart scales bars to the busiest turn shown', () => {
  expect(chart([r(36100), r(134400), r(161100)])).toBe('▂▆█')
})

test('addReading drops the 0 reading, skips repeats and keeps 12', () => {
  const zero = addReading([], { tokens: 0, window: 200000, percent: 0 })
  expect(zero).toEqual([r(0)])
  const first = addReading(zero, { tokens: 36100, window: 200000, percent: 18 })
  expect(first).toEqual([{ tokens: 36100, window: 200000, percent: 18 }])
  // 読み込み直した直後の同じ値は足さない
  expect(addReading(first, { tokens: 36100, window: 200000, percent: 18 })).toBe(first)
  // 応答前の 0 が後から来ても履歴を壊さない
  expect(addReading(first, { tokens: 0, window: 200000 })).toBe(first)
  let many = first
  for (let i = 1; i <= 20; i++) many = addReading(many, { tokens: 36100 + i * 1000, window: 200000 })
  expect(many.length).toBe(12)
})

function stubEngine(on, usage) {
  const store = new Map()
  on('store.get', async ($, e) => ({ value: store.get(e.key) }))
  on('store.set', async ($, e) => (store.set(e.key, e.value), { value: undefined }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: usage.current, rateLimits: [] } }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', async () => ({ text: '' }))
  on('command.register', async () => ({ value: undefined }))
  on('ui.render', async ($, e) => $.ui.resolve(e).Box({ children: [] }))
}

const BAND = {
  plugin: 'token-weather',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const

for (const surface of ['terminal', 'desktop'] as const) {
  test('band follows the turns on ' + surface, async ($, on) => {
    const usage = { current: { tokens: 0, window: 200000, percent: 0 } }
    stubEngine(on, usage)
    await $.session.start({ cwd: '/tmp' })
    let ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '0% of context' })).toBeDefined()

    usage.current = { tokens: 36100, window: 200000, percent: 18 }
    await $.turn.complete(TURN)
    usage.current = { tokens: 134400, window: 200000, percent: 67 }
    await $.turn.complete(TURN)
    ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '☂  Showers' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '67% of context' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '134.4k / 200k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '▲ +98.3k last turn' })).toBeDefined()
  })
}

test('subagent turns are not counted', async ($, on) => {
  const usage = { current: { tokens: 36100, window: 200000, percent: 18 } }
  stubEngine(on, usage)
  await $.session.start({ cwd: '/tmp' })
  usage.current = { tokens: 90000, window: 200000, percent: 45 }
  await $.turn.complete({ ...TURN, agentId: 'sub-1' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '18% of context' })).toBeDefined()
})

test('narrow band leaves out the chart', async ($, on) => {
  stubEngine(on, { current: { tokens: 36100, window: 200000, percent: 18 } })
  await $.session.start({ cwd: '/tmp' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 50 } })
  expect(await ui.find({ type: 'Text', text: /last turns/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '18% of context' })).toBeDefined()
})

test('/weather hides the band', async ($, on) => {
  stubEngine(on, { current: { tokens: 36100, window: 200000, percent: 18 } })
  await $.session.start({ cwd: '/tmp' })
  await $.command.run({ command: 'weather', args: '' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /of context/ })).toBeUndefined()
})
