import { expect, test } from 'claude-code/testing'
import { activeSpec, approvalPrompt, approve, currentStep, summarize } from '../hooks/register.js'

const STEPS = [
  { id: 'request', label: '要求整理', file: '01-request.md' },
  { id: 'impact', label: '影響画面確認', file: '02-impact.md' },
  { id: 'requirements', label: '要件定義', file: '03-requirements.md' },
  { id: 'options', label: '機能案・UI案', file: '04-options.md' },
]

function progress(id: string, title: string, statuses: string[], updatedAt = '2026-10-02T09:00:00.000Z') {
  return { version: 1, id, title, request: '', local: false, createdAt: updatedAt, updatedAt, chosen: null, steps: STEPS.map((s, k) => ({ ...s, status: statuses[k] })) }
}

test('summarize keeps only what the checklist shows', () => {
  const s = summarize('a', progress('a', 'CSV 書き出し', ['approved', 'review', 'pending', 'weird']))
  expect(s.steps.map((x) => x.status)).toEqual(['approved', 'review', 'pending', 'pending'])
  expect(summarize('b', { title: 'no steps' })).toBe(null)
})

test('current step and active spec', () => {
  const done = summarize('done', progress('done', '終わった', ['approved', 'approved', 'approved', 'approved']))
  const open = summarize('open', progress('open', '途中', ['approved', 'review', 'pending', 'pending']))
  expect(currentStep(done)).toBe(null)
  expect(currentStep(open).id).toBe('impact')
  expect(activeSpec([done, open]).id).toBe('open')
  expect(activeSpec([done])).toBe(null)
})

test('approve marks only that step', () => {
  const next = approve(progress('a', 'x', ['approved', 'review', 'pending', 'pending']), 'impact', 'NOW')
  expect(next.steps.map((s) => s.status)).toEqual(['approved', 'approved', 'pending', 'pending'])
  expect(next.updatedAt).toBe('NOW')
  expect(next.steps[1].approvedAt).toBe('NOW')
})

test('approval prompt calls the skill with the id', () => {
  const spec = summarize('20261002-csv-export', progress('20261002-csv-export', 'CSV', ['review', 'pending', 'pending', 'pending']))
  const text = approvalPrompt(spec, spec.steps[0])
  expect(text.startsWith('/')).toBe(false)
  expect(text).toMatch(/^spec-flow:spec スキルで/)
  expect(text).toMatch(/docs\/specs\/20261002-csv-export/)
})

// エンジンは作業フォルダからの絶対パスで渡すので、docs/specs からの相対に戻す
const rel = (p: string) => (p.includes('docs/specs') ? p.slice(p.indexOf('docs/specs')) : p)

// docs/specs をメモリ上のファイルで置き換える
function stubEngine(on, files: Map<string, string>) {
  const submitted: string[] = []
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: undefined }))
  on('fs.exists', async ($, e) => ({ value: [...files.keys()].some((k) => k === rel(e.path) || k.startsWith(rel(e.path) + '/')) }))
  on('fs.list', async ($, e) => {
    const dir = rel(e.path)
    const names = new Set([...files.keys()].filter((k) => k.startsWith(dir + '/')).map((k) => k.slice(dir.length + 1).split('/')[0]))
    return { value: [...names].map((name) => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', async ($, e) => {
    if (!files.has(rel(e.path))) throw new Error('ENOENT')
    return { value: files.get(rel(e.path)) }
  })
  on('fs.write', async ($, e) => (files.set(rel(e.path), e.text), { value: undefined }))
  on('clock.now', async () => ({ value: Date.parse('2026-10-02T10:00:00.000Z') }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('prompt.submit', async ($, e) => (submitted.push(e.text), {}))
  on('turn.complete', async () => ({ text: '' }))
  on('ui.render', async ($, e) => $.ui.resolve(e).Box({ children: [] }))
  return submitted
}

const BAND = { plugin: 'spec-flow', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const
const PANE = { plugin: 'spec-flow', component: 'Pane', requestId: 'spec-flow', props: { title: 'spec-flow', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const
const PATH = 'docs/specs/20261002-csv-export/progress.json'

for (const surface of ['terminal', 'desktop'] as const) {
  test('checking a step in review approves it and asks Claude to go on, on ' + surface, async ($, on) => {
    const files = new Map([[PATH, JSON.stringify(progress('20261002-csv-export', '一覧を CSV で書き出す', ['approved', 'review', 'pending', 'pending']))]])
    const submitted = stubEngine(on, files)
    await $.session.start({ cwd: '/repo' })

    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: '◆ 一覧を CSV で書き出す' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '[?] 影響画面確認' })).toBeDefined()

    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: /\[x\] 要求整理/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /影響画面確認  確認待ち/ })).toBeDefined()
    await pane.press({ key: 'approve-20261002-csv-export-impact' })

    expect(JSON.parse(files.get(PATH)).steps.map((s) => s.status)).toEqual(['approved', 'approved', 'pending', 'pending'])
    expect(submitted.length).toBe(1)
    expect(submitted[0]).toMatch(/docs\/specs\/20261002-csv-export/)
    expect(submitted[0]).toMatch(/影響画面確認」を承認しました/)
  })
}

test('the revise box sends the correction to the skill', async ($, on) => {
  const files = new Map([[PATH, JSON.stringify(progress('20261002-csv-export', 'CSV', ['review', 'pending', 'pending', 'pending']))]])
  const submitted = stubEngine(on, files)
  await $.session.start({ cwd: '/repo' })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.input({ key: 'revise-20261002-csv-export', text: '権限ごとの違いも聞いて' })
  expect(submitted[0]).toMatch(/「要求整理」を次のとおり直して/)
  expect(submitted[0]).toMatch(/権限ごとの違いも聞いて$/)
  // 修正依頼では承認しない
  expect(JSON.parse(files.get(PATH)).steps[0].status).toBe('review')
})

test('no band when every spec is done', async ($, on) => {
  const files = new Map([[PATH, JSON.stringify(progress('20261002-csv-export', 'CSV', ['approved', 'approved', 'approved', 'approved']))]])
  stubEngine(on, files)
  await $.session.start({ cwd: '/repo' })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /◆/ })).toBeUndefined()
})

test('an empty repo shows how to start', async ($, on) => {
  stubEngine(on, new Map())
  await $.session.start({ cwd: '/repo' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: 'まだ要望がありません。' })).toBeDefined()
})

test('a progress.json written by the skill shows up at once', async ($, on) => {
  const files = new Map<string, string>()
  stubEngine(on, files)
  on('tool.call', async ($, e) => {
    files.set(PATH, e.content)
    return { result: 'ok' }
  })
  await $.session.start({ cwd: '/repo' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/' + PATH, content: JSON.stringify(progress('20261002-csv-export', 'CSV', ['in_progress', 'pending', 'pending', 'pending'])) })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: '[~] 要求整理' })).toBeDefined()
})
