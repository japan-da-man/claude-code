// 役に渡すプロンプトの組み立てと、判定役の答えの読み取り。
import { readFileSync } from 'node:fs'

export function render(name, vars) {
  const template = readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), 'utf8')
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (vars[key] === undefined || vars[key] === null) throw new Error(`プロンプト ${name} の ${key} がありません`)
    return String(vars[key])
  })
}

// 判定役の答えの最後の JSON 配列を読み、runs 件の { run, satisfied, symptom } になっているか確かめる。
// 形は配列そのものか、{ "runs": [...] }（判定のプロンプトが求める形）のどちらでもよい。
export function parseJudgement(text, runs) {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].pop()?.[1]
  let list
  try {
    const whole = JSON.parse(fenced ?? text)
    list = Array.isArray(whole) ? whole : whole.runs
  } catch {
    try {
      list = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1))
    } catch {
      throw new Error('判定役の答えに JSON がありません')
    }
  }
  if (!Array.isArray(list) || list.length !== runs) throw new Error(`判定は ${runs} 件のはずが ${Array.isArray(list) ? list.length : 0} 件です`)
  return list.map((r, i) => {
    if (typeof r.satisfied !== 'boolean') throw new Error(`判定 ${i + 1} 件目の satisfied が真偽値ではありません`)
    return { run: r.run ?? i + 1, satisfied: r.satisfied, symptom: r.satisfied ? null : String(r.symptom ?? '') || null }
  })
}
