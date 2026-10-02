// spec-flow: docs/specs/*/progress.json を読んで、要望ごとの 4 段階をチェックリストで見せる。
// 進行そのものは spec スキルが行い、この mod は見せることと承認・差し戻しを送ることだけをする。
// mod がなくてもスキルだけで最後まで進められる（progress.json が唯一の正）。
import { atom, read, update } from 'claude-code'

const PANE_ID = 'spec-flow'
const SPECS_DIR = 'docs/specs'
const SKILL = 'spec-flow:spec'
// ペインに出す要望の数
const MAX_SPECS = 6

const specsAtom = atom({ plugin: 'spec-flow', key: 'specs' }, [])

// 段階の状態ごとの印
export const MARKS = { approved: '[x]', review: '[?]', in_progress: '[~]', pending: '[ ]' }

// progress.json の中身を、表示に使う形にする。形が違えば null
export function summarize(id, progress) {
  if (!progress || !Array.isArray(progress.steps)) return null
  return {
    id,
    title: String(progress.title || id),
    updatedAt: String(progress.updatedAt || progress.createdAt || ''),
    chosen: progress.chosen ?? null,
    steps: progress.steps.map((s) => ({
      id: String(s.id),
      label: String(s.label || s.id),
      status: MARKS[s.status] ? s.status : 'pending',
      file: String(s.file || ''),
    })),
  }
}

export function isDone(spec) {
  return spec.steps.every((s) => s.status === 'approved')
}

// 今の段階: 承認されていない最初の段階。全部承認済みなら null
export function currentStep(spec) {
  return spec.steps.find((s) => s.status !== 'approved') ?? null
}

// 帯に出す要望: 終わっていないもののうち一番新しいもの
export function activeSpec(specs) {
  return specs.find((s) => !isDone(s)) ?? null
}

export function stepLine(step) {
  const note = { review: '  確認待ち', in_progress: '  作業中' }[step.status] ?? ''
  return `${MARKS[step.status]} ${step.label}${note}`
}

// 承認したあと Claude に送る文。スキルは progress.json を読み直して次の段階から続ける。
// / で始まる文はコマンドとして扱われ送れないので、スキル名を文中で頼む
export function approvalPrompt(spec, step) {
  return `${SKILL} スキルで spec「${spec.title}」（${SPECS_DIR}/${spec.id}）を続けてください。チェックリストで「${step.label}」を承認しました。progress.json を読み直して次の段階に進んでください。`
}

export function revisePrompt(spec, step, text) {
  return `${SKILL} スキルで spec「${spec.title}」（${SPECS_DIR}/${spec.id}）の「${step.label}」を次のとおり直して、もう一度確認待ちにしてください。\n${text}`
}

export function resumePrompt(spec) {
  return `${SKILL} スキルで spec「${spec.title}」（${SPECS_DIR}/${spec.id}）を続けてください。`
}

// Claude に頼む。await しない: Claude が作業中だとターンが終わるまで解決しないため
function ask($, text) {
  $.prompt.submit({ text }).catch(() => $.ui.toast('spec-flow: Claude に送れませんでした'))
}

// progress.json の 1 段階を承認済みにした次の中身を返す
export function approve(progress, stepId, now) {
  return {
    ...progress,
    updatedAt: now,
    steps: progress.steps.map((s) => (s.id === stepId ? { ...s, status: 'approved', approvedAt: now } : s)),
  }
}

// docs/specs を読み直して state に置く。読めないものは飛ばす
async function scan($) {
  const specs = []
  try {
    if (await $.fs.exists(SPECS_DIR)) {
      for (const entry of await $.fs.list(SPECS_DIR)) {
        if (entry.kind !== 'dir') continue
        try {
          const spec = summarize(entry.name, JSON.parse(await $.fs.read(`${SPECS_DIR}/${entry.name}/progress.json`)))
          if (spec) specs.push(spec)
        } catch {
          // progress.json がないか壊れている
        }
      }
    }
  } catch {
    // 読めなければ空のまま
  }
  specs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  await update($, specsAtom, () => specs)
}

// チェックを入れた段階を承認して、Claude に続きを頼む
async function approveStep($, spec, step) {
  const path = `${SPECS_DIR}/${spec.id}/progress.json`
  try {
    const progress = JSON.parse(await $.fs.read(path))
    const now = new Date(await $.clock.now()).toISOString()
    await $.fs.write(path, JSON.stringify(approve(progress, step.id, now), null, 2) + '\n')
  } catch {
    $.ui.toast(`spec-flow: ${path} を書き換えられませんでした`)
    return
  }
  await scan($)
  $.ui.toast(`spec-flow: 「${step.label}」を承認しました`)
  ask($, approvalPrompt(spec, step))
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await scan($)
    await $.command.register({ name: 'specs', description: 'spec-flow: 要望ごとの進み具合を開く', immediate: true })
    return r
  })

  on('command.run', { command: 'specs' }, async ($) => {
    await scan($)
    await $.ui.open({ id: PANE_ID, title: 'spec-flow', focus: true, closeOnEscape: true })
    return {}
  })

  // スキルが progress.json を書いたら、すぐ表示に反映する
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if ((e.tool === 'Write' || e.tool === 'Edit') && String(e.file_path || '').endsWith('/progress.json')) await scan($)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) await scan($)
    return r
  })

  // プロンプトの上: 進行中の要望の 4 段階
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const spec = activeSpec(await read($, specsAtom))
    if (!spec || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const marks = spec.steps.map((s, k) =>
      Text({ key: `s${k}`, color: s.status === 'approved' ? 'green' : s.status === 'review' ? 'yellow' : undefined, dimColor: s.status === 'pending', children: `${MARKS[s.status]} ${s.label}` }),
    )
    const line = Box({
      flexDirection: 'row',
      gap: 2,
      paddingX: 1,
      children: [
        Text({ color: 'cyan', bold: true, wrap: 'truncate-end', children: `◆ ${spec.title}` }),
        ...((e.props.bodyColumns ?? 80) >= 90 ? marks : []),
        Button({ key: 'open-specs', label: 'Specs', hotkey: 's', onPress: () => $.ui.open({ id: PANE_ID, title: 'spec-flow', focus: true, closeOnEscape: true }) }),
      ],
    })
    // 他の mod が帯に描くものも残す
    const rest = await next(e)
    return rest ? Box({ flexDirection: 'column', children: [line, rest] }) : line
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const specs = (await read($, specsAtom)).slice(0, MAX_SPECS)
    if (!specs.length) {
      return Box({
        flexDirection: 'column',
        children: [
          Text({ children: 'まだ要望がありません。' }),
          Text({ dimColor: true, children: `「〇〇な機能が欲しい」と話しかけるか、/${SKILL} <要望> で始めます。` }),
        ],
      })
    }

    const blocks = specs.map((spec, n) => {
      const current = currentStep(spec)
      const rows = spec.steps.map((step, k) => {
        const key = `${spec.id}-${step.id}`
        const file = step.file ? `  ${SPECS_DIR}/${spec.id}/${step.file}` : ''
        // 確認待ちの段階だけ押せるチェックボックスにする
        if (step.status === 'review') {
          return Box({
            key,
            flexDirection: 'row',
            gap: 1,
            children: [
              Button({ key: `approve-${key}`, label: '[ ]', plain: true, autoFocus: n === 0, onPress: () => approveStep($, spec, step) }),
              Text({ color: 'yellow', children: `${step.label}  確認待ち（チェックで承認して次へ）` }),
              Text({ dimColor: true, wrap: 'truncate-start', children: file }),
            ],
          })
        }
        return Text({
          key,
          color: step.status === 'approved' ? 'green' : undefined,
          dimColor: step.status === 'pending',
          wrap: 'truncate-end',
          children: stepLine(step) + (step.status === 'approved' ? file : ''),
        })
      })

      const extra = []
      if (current?.status === 'review') {
        extra.push(
          Input({
            key: `revise-${spec.id}`,
            label: '直してほしい点',
            placeholder: `「${current.label}」への修正を書いて Enter`,
            value: '',
            submitLabel: '送る',
            onSubmit: (value) => {
              const text = value.trim()
              if (!text) return
              $.ui.toast(`spec-flow: 「${current.label}」の修正を依頼しました`)
              ask($, revisePrompt(spec, current, text))
            },
          }),
        )
      } else if (current) {
        extra.push(Button({ key: `resume-${spec.id}`, label: '続きを進める', onPress: () => ask($, resumePrompt(spec)) }))
      } else if (spec.chosen) {
        extra.push(Text({ dimColor: true, children: `採用案: ${spec.chosen}` }))
      }

      return Box({
        key: spec.id,
        flexDirection: 'column',
        marginBottom: 1,
        children: [
          Text({ bold: true, color: isDone(spec) ? 'green' : 'cyan', children: `${isDone(spec) ? '✔' : '◆'} ${spec.title}` }),
          Text({ dimColor: true, children: `${SPECS_DIR}/${spec.id}` }),
          ...rows,
          ...extra,
        ],
      })
    })

    return Box({
      flexDirection: 'column',
      children: [...blocks, Text({ dimColor: true, children: '[x] 承認済み · [?] 確認待ち · [~] 作業中 · Tab で移動 · Esc で閉じる' })],
    })
  })
}
