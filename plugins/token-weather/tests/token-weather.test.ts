import { expect, test } from 'claude-code/testing'
import { forecast, formatDelta, formatTokens, nextWeather, sparkline } from '../hooks/register.js'

const BAND = {
  plugin: 'token-weather',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

// Claude Code 本体の代わりに応答する
function stubEngine(on) {
  const store = new Map()
  on('store.get', async ($, e) => ({ value: store.get(e.key) }))
  on('store.set', async ($, e) => (store.set(e.key, e.value), { value: undefined }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('session.measure', async ($, e) => ({ changed: e.changed }))
  on('command.register', async () => ({ value: undefined }))
  // 帯に何も描かない本体
  on('ui.render', async ($, e) => $.ui.resolve(e).Box({ children: [] }))
}

test('forecast changes with the fill', () => {
  expect(forecast(8).label).toBe('Clear')
  expect(forecast(45).label).toBe('Partly cloudy')
  expect(forecast(60).label).toBe('Cloudy')
  expect(forecast(80).label).toBe('Rain')
  expect(forecast(95).label).toBe('Storm')
})

test('formats token counts', () => {
  expect(formatTokens(9000)).toBe('9k')
  expect(formatTokens(200000)).toBe('200k')
  expect(formatTokens(1000000)).toBe('1M')
})

test('formats the per-turn delta', () => {
  expect(formatDelta(12000)).toBe('+12k')
  expect(formatDelta(-80000)).toBe('−80k')
  expect(formatDelta(0)).toBe('±0')
})

test('sparkline maps percent to bars', () => {
  expect(sparkline([0, 50, 100])).toBe('▁▅█')
})

test('band shows the weather after a measurement', async ($, on) => {
  stubEngine(on)
  await $.session.measure({ context: { tokens: 160000, window: 200000, percent: 80 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Rain' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '80% of context' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '160k / 200k' })).toBeDefined()
})

test('band shows how many tokens the last turn added', async ($, on) => {
  stubEngine(on)
  await $.session.measure({ context: { tokens: 40000, window: 200000, percent: 20 }, rateLimits: [], changed: ['context'] })
  await $.session.measure({ context: { tokens: 52000, window: 200000, percent: 26 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /last turns .*\+12k/ })).toBeDefined()
})

test('a repeated measurement with the same fill is not a turn', async ($, on) => {
  stubEngine(on)
  await $.session.measure({ context: { tokens: 60000, window: 200000, percent: 30 }, rateLimits: [], changed: ['context'] })
  await $.session.measure({ context: { tokens: 70000, window: 200000, percent: 35 }, rateLimits: [], changed: ['context'] })
  await $.session.measure({ context: { tokens: 70000, window: 200000, percent: 35 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /last turns .*\+10k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /±0/ })).toBeUndefined()
})

test('nextWeather keeps history when the same usage is fed again after a reload', () => {
  const empty = { history: [], context: null, delta: null }
  const a = nextWeather(empty, { tokens: 40000, window: 200000, percent: 20 })
  expect(a).toEqual({ history: [20], context: { tokens: 40000, window: 200000, percent: 20 }, delta: null })
  const b = nextWeather(a, { tokens: 52000, window: 200000, percent: 26 })
  expect(b.history).toEqual([20, 26])
  expect(b.delta).toBe(12000)
  // 読み込み直した直後の session.start と最初の計測は同じ値を持ってくる。履歴も増減も変えない
  expect(nextWeather(b, { tokens: 52000, window: 200000, percent: 26 })).toBe(b)
  // 最初の応答前（使用率なし）は何も変えない
  expect(nextWeather(b, { window: 200000 })).toBe(b)
})

test('/weather hides the band', async ($, on) => {
  stubEngine(on)
  await $.command.run({ command: 'weather', args: '' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /of context/ })).toBeUndefined()
})
