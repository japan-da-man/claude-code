// 試用ルールと試用 Skill に書き込む前の、中身の検査。
// 改善候補は会話の内容から LLM が書いたもので、外から来た文章が混ざりうる。
// 指示の上書き・ガードの回避・外部への送信を促す文と、読み込み時に実行される書き方を拒否する。
// 言い回しの照合なので、すり抜けも誤検知もある。人の確認（review）が最後の関門。

const NEGATED = '(?!\\s*(?:しない|せず|するな|してはいけない|してはならない|しては|を禁止|禁止))'

const BLOCKED = [
  { kind: '指示の上書き', re: /(ignore|disregard|forget|override)\s+(all\s+|any\s+)?(of\s+)?(the\s+|your\s+)?(previous|prior|above|earlier|system|other)\s+(instructions?|prompts?|rules?|guidelines?)/i },
  { kind: '指示の上書き', re: /(これまで|今まで|以前|上記|ここまで|ほか|他|システム)の?(指示|ルール|プロンプト|命令|決まり)(は|を)?(すべて|全て|全部)?(無視|忘れ|破棄|上書き|優先しない)/ },
  { kind: '指示の上書き', re: /system\s*prompt|システム\s*プロンプト/i },
  { kind: '指示の上書き', re: new RegExp(`(ユーザー|利用者|人)の(指示|確認|承認|許可)(を|は)?(待たず|待たない|無視|省略|不要)${NEGATED}`) },
  // 「--no-verify を使わない」のような、禁じる側のルールは通す（前後に否定があるとき）。
  {
    kind: 'ガードの回避',
    re: /HARNESS_DISABLE|disableAllHooks|--no-verify|bypassPermissions|dangerously-skip-permissions|--dangerously|permissions?\.(allow|deny)|settings(\.local)?\.json/i,
    unlessAfter: /^[^。\n]{0,25}(使わない|使用しない|付けない|つけない|書き換えない|編集しない|変えない|しない|せず|禁止|避ける|やめる)/,
    unlessBefore: /(never|don'?t|do not|must not|avoid)\s+(?:\w+\s+){0,2}$/i,
  },
  { kind: 'ガードの回避', re: new RegExp(`(ガード|guard|hooks?|フック|ハーネス|harness|検証|verify|権限|承認|確認|許可)(を|は|の)?(回避|無効化?|外す|外して|止める|止めて|スキップ|迂回|バイパス|すり抜け|省略)${NEGATED}`, 'i') },
  { kind: 'ガードの回避', re: /(bypass|disable|skip|circumvent|turn\s+off|work\s+around)\s+(the\s+|any\s+)?(guards?|hooks?|harness|verification|permissions?|approvals?|confirmations?|checks?)/i },
  { kind: '外部への送信', re: /https?:\/\//i },
  { kind: '外部への送信', re: /\b(curl|wget)\b[^\n]*(\s-d\b|--data|\s-F\b|--form|\s-T\b|--upload|-X\s*(POST|PUT|PATCH)|\|\s*(ba|z)?sh\b)/i },
  { kind: '外部への送信', re: /\b(nc|netcat|scp|sftp|ftp)\s+\S/i },
  { kind: '外部への送信', re: new RegExp(`(外部|社外|サーバー?|webhook|Slack|メール|第三者|リモート)(に|へ|宛に)[^。\\n]{0,20}(送信|送る|送って|アップロード|投稿|転送)${NEGATED}`, 'i') },
  { kind: '外部への送信', re: /\b(send|upload|post|exfiltrate|forward|email)\b[^.\n]{0,60}\bto\s+(an?\s+|the\s+)?(external|remote|third[- ]party|webhook|server|slack|e-?mail)/i },
  { kind: '読み込み時の実行', re: /!`/ },
  { kind: '読み込み時の実行', re: /^\s*```!/m },
  { kind: '読み込み時の実行', re: /^#!\s*\//m },
  { kind: '読み込み時の実行', re: /<script\b/i },
]

export function scanText(text) {
  const found = []
  for (const { kind, re, unlessAfter, unlessBefore } of BLOCKED) {
    const match = re.exec(text)
    if (!match) continue
    const after = text.slice(match.index + match[0].length)
    const before = text.slice(0, match.index)
    if ((unlessAfter && unlessAfter.test(after)) || (unlessBefore && unlessBefore.test(before))) continue
    found.push(`${kind}に当たる表現があります：「${match[0].slice(0, 60)}」`)
  }
  // 制御文字（改行とタブ以外）は、表示をごまかすのに使えるので拒否する。
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/.test(text)) {
    found.push('制御文字や不可視の文字が含まれています')
  }
  return found
}

export const RULE_MAX_CHARS = 200

// 文章ルールは「命令形 1 行」。失敗票の ID は harness-note が後ろに付ける。
export function validateRuleText(raw) {
  const text = String(raw ?? '').trim().replace(/^[-*]\s+/, '')
  const errors = []
  if (!text) errors.push('ルールの本文が空です')
  if (/[\r\n]/.test(text)) errors.push('ルールは 1 行で書いてください（改行は使えません）')
  if (text.length > RULE_MAX_CHARS) errors.push(`ルールは ${RULE_MAX_CHARS} 文字までです（いま ${text.length} 文字）。詳しい手順は Skill にします`)
  errors.push(...scanText(text))
  return { ok: errors.length === 0, errors, text }
}

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
export const SKILL_MAX_LINES = 200
export const SKILL_MAX_CHARS = 8000
export const SKILL_DESCRIPTION_MAX = 1024
const ALLOWED_FRONTMATTER = ['name', 'description']

// 試用 Skill の設定欄は name と description だけ、本文は文章だけ。
// hooks・allowed-tools・model などの設定欄を使うと、確認なしの実行や hook を持ち込めるので拒否する。
export function validateSkill({ name, description, body, frontmatterKeys = [], repoName }) {
  const errors = []
  const extra = frontmatterKeys.filter((k) => !ALLOWED_FRONTMATTER.includes(k))
  if (extra.length) errors.push(`試用 Skill の設定欄に書けるのは name と description だけです（拒否：${extra.join('、')}）`)
  if (!SKILL_NAME.test(String(name ?? ''))) errors.push('name は英小文字・数字・ハイフンで 40 文字まで（先頭は英数字）にしてください')
  const desc = String(description ?? '').trim()
  if (!desc) errors.push('description が空です')
  if (/[\r\n]/.test(desc)) errors.push('description は 1 行で書いてください')
  if (desc.length > SKILL_DESCRIPTION_MAX) errors.push(`description は ${SKILL_DESCRIPTION_MAX} 文字までです`)
  if (repoName && desc && !desc.includes(repoName)) {
    errors.push(`description に、どのリポジトリの作業で使うかを書いてください（リポジトリ名「${repoName}」を含める）`)
  }
  const text = String(body ?? '').replace(/\r\n/g, '\n').trim()
  if (!text) errors.push('本文が空です')
  if (/^---\s*$/m.test(text.split('\n')[0] ?? '')) errors.push('本文を --- で始めないでください（設定欄は name と description だけです）')
  if (text.split('\n').length > SKILL_MAX_LINES) errors.push(`本文は ${SKILL_MAX_LINES} 行までです`)
  if (text.length > SKILL_MAX_CHARS) errors.push(`本文は ${SKILL_MAX_CHARS} 文字までです`)
  errors.push(...scanText(`${desc}\n${text}`))
  return { ok: errors.length === 0, errors, description: desc, body: text }
}

export function renderSkill({ dirName, description, body }) {
  return `---\nname: ${dirName}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`
}
