// 失敗票。全リポジトリの分を、user 側の ~/.claude/self-improve/incidents/ に置く（1 件 1 ファイル）。
// リポジトリには置かない。共有リポジトリに、個人の失敗の記録を混ぜないため。
// 書き込むのは harness-note incident add だけ（人だけの操作）。ID は、全リポジトリで 1 つの連番（INC-YYYY-NNNN）。
// どのリポジトリで起きたか（名前と ID）と、リモートの URL（認証情報は取り除く）を記録する。
// 関連する票や整合のチェックは、今のリポジトリの票だけを見る。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dayOf, listFiles, now, parseFrontmatter, tildePath, withLock, writeFileAtomic } from './core.mjs'

export const INCIDENT_ID = /^INC-\d{4}-\d{4}$/
export const INCIDENT_STATUSES = ['open', 'trial', 'converted', 'wontfix', 'retired']

// リモートの URL から、認証情報を取り除く。
//   https://user:token@host/org/repo.git?access_token=…#x  →  https://host/org/repo.git
//   git@host:org/repo.git                                   →  git@host:org/repo.git（git は利用者名で、認証情報ではない）
//   token@host:org/repo.git                                 →  host:org/repo.git
// ローカルのパス（/path/to/repo、file://…）は、記録しない（マシンの中のパスを残さないため）。
export function sanitizeRemote(raw) {
  const url = String(raw ?? '').trim()
  if (!url || /\s/.test(url)) return null
  const withScheme = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(url)
  if (withScheme) {
    const scheme = withScheme[1].toLowerCase()
    if (scheme === 'file') return null
    // 利用者名とパスワード（@ を含むパスワードでも、最後の @ までを取り除く）。
    const host = withScheme[2].slice(withScheme[2].lastIndexOf('@') + 1)
    if (!host) return null
    return `${scheme}://${host}${withScheme[3]}`
  }
  const scp = /^(?:([^@/:\s]+)@)?([^@/:\s]+):(?!\/)([^?#]+)/.exec(url)
  if (scp && !/^[A-Za-z]$/.test(scp[2])) return `${scp[1] === 'git' ? 'git@' : ''}${scp[2]}:${scp[3]}`
  return null
}

// リポジトリのリモートの URL（origin。なければ最初のリモート）。git の設定ファイルを読む。git コマンドは呼ばない。
export function remoteOf(repo) {
  let text
  try {
    text = readFileSync(join(repo.commonDir, 'config'), 'utf8')
  } catch {
    return null
  }
  const remotes = []
  let current = null
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/.exec(line)
    if (section) {
      current = { name: section[1], url: null }
      remotes.push(current)
    } else if (/^\s*\[/.test(line)) {
      current = null
    } else if (current && !current.url) {
      const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line)
      if (url) current.url = url[1].replace(/^"(.*)"$/, '$1')
    }
  }
  const chosen = remotes.find((r) => r.name === 'origin' && r.url) ?? remotes.find((r) => r.url)
  return chosen ? sanitizeRemote(chosen.url) : null
}

// すべての失敗票（全リポジトリ）。
export function listIncidents(ctx) {
  const out = []
  for (const file of listFiles(ctx.user.incidents, (f) => /^INC-\d{4}-\d{4}\.md$/.test(f))) {
    let text
    try {
      text = readFileSync(join(ctx.user.incidents, file), 'utf8')
    } catch {
      continue
    }
    const parsed = parseFrontmatter(text)
    out.push({ id: file.replace(/\.md$/, ''), file: join(ctx.user.incidents, file), data: parsed.data ?? {}, body: parsed.body, text })
  }
  return out
}

// 今のリポジトリの失敗票。関連する票と、整合のチェックは、これだけを見る。
export function repoIncidents(ctx) {
  return listIncidents(ctx).filter((i) => i.data.repo_id === ctx.repo.id)
}

export function getIncident(ctx, id) {
  return INCIDENT_ID.test(String(id)) ? listIncidents(ctx).find((i) => i.id === id) ?? null : null
}

const clean = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
const FIELD_ORDER = [
  'id', 'date', 'repo', 'repo_id', 'remote', 'area', 'category', 'signal', 'root_cause', 'cause_key', 'related', 'severity',
  'status', 'control', 'applied_by', 'trial_started_at', 'promoted_at',
]

function renderFrontmatter(fields) {
  const lines = ['---']
  for (const key of FIELD_ORDER) {
    const value = fields[key]
    if (Array.isArray(value)) lines.push(`${key}: [${value.map(clean).join(', ')}]`)
    else lines.push(`${key}: ${value === null || value === undefined || value === '' ? 'null' : clean(value)}`)
  }
  lines.push('---', '')
  return lines.join('\n')
}

// 起票する。ID は、全リポジトリの票を数えて、その年の次の番号を振る（数えてから書くまでを排他で囲む）。
// すでにあるファイルは上書きしない。
//   fields  frontmatter に入れる値（cause_key は必須。下書きから起票するときは、下書きの値を引き継いで渡す）
//   body    本文（「## 何を頼んだか」以下）
export function addIncident(ctx, { fields, body }) {
  mkdirSync(ctx.user.incidents, { recursive: true })
  return withLock(ctx.user.incidents, () => {
    const year = now().getFullYear()
    const all = listIncidents(ctx)
    const numbers = all.filter((i) => i.id.startsWith(`INC-${year}-`)).map((i) => Number(i.id.slice(-4)))
    const related = all.filter((i) => i.data.repo_id === ctx.repo.id && i.data.cause_key === fields.cause_key).map((i) => i.id)
    for (let n = Math.max(0, ...numbers) + 1; n <= 9999; n++) {
      const id = `INC-${year}-${String(n).padStart(4, '0')}`
      const file = join(ctx.user.incidents, `${id}.md`)
      const text = `${renderFrontmatter({
        area: 'unknown', category: null, signal: 'noticed', root_cause: null, severity: 'normal', status: 'open', control: null,
        applied_by: 'human', trial_started_at: null, promoted_at: null,
        ...fields,
        id, date: dayOf(), repo: ctx.repo.name, repo_id: ctx.repo.id, remote: remoteOf(ctx.repo), related,
      })}\n${String(body ?? '').trim()}\n`
      try {
        // wx：同じ名前のファイルがあれば失敗する（上書きしない）。
        writeFileSync(file, text, { flag: 'wx' })
      } catch (e) {
        if (e?.code === 'EEXIST') continue
        throw e
      }
      return { ok: true, id, file, related }
    }
    return { ok: false, errors: ['失敗票の番号を振れません（その年の番号を使い切りました）'] }
  })
}

// 失敗票の frontmatter の値を書き換える（status、control、promoted_at など）。本文は変えない。
export function updateIncident(ctx, id, changes) {
  const incident = getIncident(ctx, id)
  if (!incident) return { ok: false, errors: [`失敗票 ${id} がありません`] }
  if (incident.data.repo_id !== ctx.repo.id) {
    return { ok: false, errors: [`失敗票 ${id} は、別のリポジトリ（${incident.data.repo ?? '不明'}）のものです。そのリポジトリで操作してください`] }
  }
  let text = incident.text
  for (const [key, value] of Object.entries(changes)) {
    const line = `${key}: ${value === null || value === '' ? 'null' : clean(value)}`
    const pattern = new RegExp(`^${key}:.*$`, 'm')
    const end = text.indexOf('\n---', 3)
    const head = text.slice(0, end)
    text = pattern.test(head) ? head.replace(pattern, line) + text.slice(end) : `${head}\n${line}${text.slice(end)}`
  }
  writeFileAtomic(incident.file, text)
  return { ok: true, id, file: incident.file }
}

export const displayIncidentPath = (file) => tildePath(file)
