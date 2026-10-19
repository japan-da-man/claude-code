// 満足度の計算と、自動マージしてよいかの判定。
import { matchesGlob } from 'node:path'

// runs: 判定役が 1 回の実行ごとに出した結果 { scenario, required, satisfied, symptom }
// シナリオごとに実行の回数が違ってよい（合格すれば 1 回、落ちたときだけ再実行する）ので、
// 満足度は「シナリオごとの満足の割合」の平均にする。必須のシナリオは、すべての実行が満足であること。
export function summarize(runs) {
  const byScenario = new Map()
  for (const r of runs) byScenario.set(r.scenario, [...(byScenario.get(r.scenario) ?? []), r])
  const shares = [...byScenario.values()].map((rs) => rs.filter((r) => r.satisfied).length / rs.length)
  const satisfied = runs.filter((r) => r.satisfied).length
  const requiredFailures = [...new Set(runs.filter((r) => r.required && !r.satisfied).map((r) => r.scenario))]
  const symptoms = [...new Set(runs.filter((r) => !r.satisfied && r.symptom).map((r) => r.symptom))]
  const score = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 0
  return { total: runs.length, satisfied, score, requiredFailures, symptoms }
}

export function protectedChanges(changedFiles, globs) {
  return changedFiles.filter((f) => globs.some((g) => matchesGlob(f, g)))
}

// ビルドのときに任意のコマンドを動かせる設定。xcodebuild はサンドボックスの外で動くので、
// 実装役がここにスクリプトを足すと、隠しシナリオを読めてしまう（DESIGN.md 11節の抜け道）。
const BUILD_SCRIPT_RULES = [
  { file: /(^|\/)project\.ya?ml$/, line: /\b(preBuildScripts|postBuildScripts|postCompileScripts|buildToolPlugins|buildRules)\b|^\s*-?\s*script\s*:/ },
  { file: /\.pbxproj$/, line: /PBXShellScriptBuildPhase|shellScript\s*=|PBXBuildRule/ },
  { file: /\.xcscheme$/, line: /<(PreActions|PostActions)\b|ShellScriptAction/ },
  { file: /(^|\/)Package\.swift$/, line: /\.plugin\s*\(|\bplugins\s*:/ },
]

// unified diff の追加行から、ビルドの設定に足されたスクリプトを探す。[{ file, line }] を返す。
export function buildScriptChanges(diff) {
  const hits = []
  let file = null
  for (const l of diff.split('\n')) {
    const head = /^\+\+\+ (?:b\/)?(.+)$/.exec(l)
    if (head) {
      file = head[1] === '/dev/null' ? null : head[1]
      continue
    }
    if (!file || !l.startsWith('+') || l.startsWith('+++')) continue
    const rule = BUILD_SCRIPT_RULES.find((r) => r.file.test(file))
    if (rule?.line.test(l.slice(1))) hits.push({ file, line: l.slice(1).trim() })
  }
  return hits
}

export const isTestFile = (f) => /(^|\/)[^/]*Tests?(\/|\.swift$)/.test(f)

// git diff --numstat の出力から、変わった行の合計（足した行 + 消した行）を出す。画像などの "-" は数えない。
export function changedLines(numstat) {
  return numstat
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 3)
    .reduce((sum, [a, d]) => sum + (Number(a) || 0) + (Number(d) || 0), 0)
}

// 判定の材料（どれも、その条件がないときは undefined か null で渡す）
// - summary: 開発用シナリオの満足度 / holdout: 最終関門のシナリオの満足度
// - designPassed / lintPassed: デザインシステムのチェックと lint の結果
// - codeChanged: 仕様のほかに変わったファイルがあるか / testsAdded: テストのファイルが変わったか
// - buildScripts: ビルドの設定に足されたスクリプト / mutantDetected: 壊したアプリを必須シナリオが見つけたか
// - diffLines, maxLines: 変わった行の数と上限 / ci: 'none' か 'success' / 'failure'
// 返す stop は、もう 1 周しても直らない（人に見てもらう）理由があるか。
// 最終関門の不合格は、症状を返して周を重ねると中身が実装役に伝わるので、止める。
export function decideMerge({ summary, threshold, testsPassed, designPassed, lintPassed, codeChanged, testsAdded, buildScripts = [], ci, protectedHits, holdout = null, mutantDetected = null, diffLines = 0, maxLines = Infinity }) {
  const reasons = []
  const final = []
  if (codeChanged === false) reasons.push('実装の変更がない（仕様のほかに、変わったファイルがない）')
  if (buildScripts.length) reasons.push(`ビルドの設定にスクリプトを足している: ${[...new Set(buildScripts.map((b) => b.file))].join(', ')}`)
  if (designPassed === false) reasons.push('デザインシステムの決まりに違反している')
  if (lintPassed === false) reasons.push('lint が通らない')
  if (testsAdded === false) reasons.push('振る舞いを確かめるテストが足されていない')
  if (summary.score < threshold) reasons.push(`満足度 ${(summary.score * 100).toFixed(1)}% が基準 ${threshold * 100}% に届かない`)
  if (summary.requiredFailures.length) reasons.push(`必須シナリオが不合格: ${summary.requiredFailures.join(', ')}`)
  if (!testsPassed) reasons.push('ローカルのビルドか全テストが通らない')
  if (protectedHits.length) reasons.push(`禁止ファイルを変更している: ${protectedHits.join(', ')}`)
  if (holdout && (holdout.score < threshold || holdout.requiredFailures.length)) final.push(`最終関門のシナリオが不合格（満足度 ${(holdout.score * 100).toFixed(1)}%${holdout.requiredFailures.length ? `、必須: ${holdout.requiredFailures.join(', ')}` : ''}）`)
  if (mutantDetected === false) final.push('わざと壊したアプリも必須シナリオに合格した（シナリオか判定が甘い）')
  if (diffLines > maxLines) final.push(`変更が ${diffLines} 行で、自動マージの上限 ${maxLines} 行を超える（人が見る）`)
  if (ci !== 'none' && ci !== 'success') final.push(`GitHub の CI が ${ci}`)
  return { merge: reasons.length + final.length === 0, reasons: [...reasons, ...final], stop: final.length > 0 }
}
