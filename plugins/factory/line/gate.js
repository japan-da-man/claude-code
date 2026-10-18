// 満足度の計算と、自動マージしてよいかの判定。
import { matchesGlob } from 'node:path'

// runs: 判定役が 1 回の実行ごとに出した結果 { scenario, required, satisfied, symptom }
export function summarize(runs) {
  const satisfied = runs.filter((r) => r.satisfied).length
  const requiredFailures = [...new Set(runs.filter((r) => r.required && !r.satisfied).map((r) => r.scenario))]
  const symptoms = [...new Set(runs.filter((r) => !r.satisfied && r.symptom).map((r) => r.symptom))]
  return { total: runs.length, satisfied, score: runs.length ? satisfied / runs.length : 0, requiredFailures, symptoms }
}

export function protectedChanges(changedFiles, globs) {
  return changedFiles.filter((f) => globs.some((g) => matchesGlob(f, g)))
}

// ci: GitHub に CI がなければ 'none'。あれば 'success' / 'failure'（待ち終わった結果）。
export function decideMerge({ summary, threshold, testsPassed, ci, protectedHits }) {
  const reasons = []
  if (summary.score < threshold) reasons.push(`満足度 ${(summary.score * 100).toFixed(1)}% が基準 ${threshold * 100}% に届かない`)
  if (summary.requiredFailures.length) reasons.push(`必須シナリオが不合格: ${summary.requiredFailures.join(', ')}`)
  if (!testsPassed) reasons.push('ローカルのビルドか全テストが通らない')
  if (ci !== 'none' && ci !== 'success') reasons.push(`GitHub の CI が ${ci}`)
  if (protectedHits.length) reasons.push(`禁止ファイルを変更している: ${protectedHits.join(', ')}`)
  return { merge: reasons.length === 0, reasons }
}
