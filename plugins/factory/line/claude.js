// 役（実装・検証・判定）ごとに、新しいヘッドレスの Claude Code セッションを呼ぶ。
import { spawn } from 'node:child_process'

export class UsageLimitError extends Error {
  constructor(resetAt, message) {
    super(message)
    this.resetAt = resetAt
  }
}

// hide: 実装役から隠すディレクトリ（工場の置き場所）。Read ツールは deny で、
// Bash から読む抜け道はサンドボックスで塞ぐ。サンドボックスが使えなければ起動しない。
// unsandboxed: サンドボックスの中では動かないコマンド（xcodebuild はシミュレーターのサービスに繋がらない）。
// addDirs: 検証役・判定役に読ませるディレクトリ。
export function buildArgs({ model, allowedTools, hide = null, unsandboxed = [], addDirs = [] }) {
  const args = ['-p', '--output-format', 'json', '--model', model, '--permission-mode', 'dontAsk', '--allowedTools', allowedTools.join(',')]
  for (const d of addDirs) args.push('--add-dir', d)
  if (hide) {
    const settings = {
      permissions: { deny: ['Read', 'Edit', 'Write', 'Grep', 'Glob'].map((t) => `${t}(/${hide}/**)`) },
      sandbox: { enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true, excludedCommands: unsandboxed, filesystem: { denyRead: [hide] } },
    }
    args.push('--settings', JSON.stringify(settings))
  }
  return args
}

const FALLBACK_WAIT = 30 * 60 * 1000

// 利用上限のメッセージから、枠が戻る時刻（ミリ秒）を取り出す。時刻が書かれていなければ 30 分後とみなす。
export function parseUsageLimit(text, now = Date.now()) {
  const epoch = /usage limit reached\|(\d+)/i.exec(text)
  if (epoch) return Number(epoch[1]) * 1000
  if (/usage limit|hit your limit|rate limit/i.test(text)) return now + FALLBACK_WAIT
  return null
}

// プロンプトは引数ではなく標準入力で渡す（長さの制限とプロセス一覧への露出を避ける）。
export function runClaude({ bin = 'claude', cwd, env = process.env, prompt, ...role }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, buildArgs(role), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      let json = null
      try {
        json = JSON.parse(out)
      } catch {}
      const text = json?.result ?? out + err
      const resetAt = parseUsageLimit(String(text))
      if (resetAt !== null && (json?.is_error || code !== 0)) return reject(new UsageLimitError(resetAt, String(text)))
      if (code !== 0 || !json || json.is_error) return reject(new Error(`claude が失敗しました (exit ${code}): ${String(text).slice(0, 2000)}`))
      resolve(json)
    })
    child.stdin.end(prompt)
  })
}

const MARGIN = 60 * 1000

// 利用上限に当たったら、枠が戻るまで待って同じ呼び出しをやり直す。
export async function withUsageWait(fn, { now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onPause = () => {} } = {}) {
  for (;;) {
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof UsageLimitError)) throw e
      const until = e.resetAt + MARGIN
      onPause(until)
      await sleep(Math.max(0, until - now()))
    }
  }
}
