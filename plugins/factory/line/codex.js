// Codex CLI（codex exec）で役を呼ぶ。設定のモデル名が "codex" か "codex:<モデル>" のときに使う。
// Codex のサンドボックスは書き込みとネットワークを制限するが、読み取りは制限しない（2026-10-18 に確認）。
// そのため、シナリオを隠す必要のある実装役には使わない（config.js で弾く）。
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageLimitError, parseUsageLimit } from './claude.js'

export const isCodex = (model) => /^codex(:|$)/.test(model)
export const codexModel = (model) => (model.includes(':') ? model.slice(model.indexOf(':') + 1) : null)

export function buildCodexArgs({ cwd, sandbox, model, schema = null, out, addDirs = [] }) {
  const args = ['exec', '--sandbox', sandbox, '-C', cwd, '--skip-git-repo-check', '--ephemeral', '-o', out]
  const m = codexModel(model)
  if (m) args.push('-m', m)
  for (const d of addDirs) args.push('--add-dir', d)
  if (schema) args.push('--output-schema', schema)
  return args
}

// プロンプトは標準入力で渡し、入力を閉じる（開いたままだと codex exec は入力を待ち続ける）。
// 最後の返答は -o のファイルから読む。
export function runCodex({ bin = 'codex', env = process.env, prompt, ...role }) {
  const out = join(mkdtempSync(join(tmpdir(), 'factory-codex-')), 'last.txt')
  return new Promise((resolve, reject) => {
    const child = spawn(bin, buildCodexArgs({ ...role, out }), { cwd: role.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', (d) => (log += d))
    child.stderr.on('data', (d) => (log += d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        const resetAt = parseUsageLimit(log)
        if (resetAt !== null) return reject(new UsageLimitError(resetAt, log.slice(-2000)))
        return reject(new Error(`codex が失敗しました (exit ${code}): ${log.slice(-2000)}`))
      }
      try {
        resolve({ result: readFileSync(out, 'utf8') })
      } catch {
        reject(new Error(`codex の返答がありません: ${log.slice(-2000)}`))
      }
    })
    child.stdin.end(prompt)
  })
}
