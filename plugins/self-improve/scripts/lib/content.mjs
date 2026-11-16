// 試用ルールと試用 Skill に書き込む前の、中身の検査。
// 改善候補は会話の内容から LLM が書いたもので、外から来た文章が混ざりうる。
// 指示の上書き・ガードの回避・外部への送信を促す文と、読み込み時に実行される書き方を拒否する。
// 言い回しの照合なので、すり抜けも誤検知もある。人の確認（review）が最後の関門。

// 禁じる側のルール（「〜を使わない」「〜するな」）は通す。
// その文（。か改行まで）が否定で終わっているときだけ、例外にする。
// 「--no-verify を使わないのは古い決まりなので、今は付ける」のように、否定のあとに文が続くものは通さない。
const NEGATIVE_ENDING = /(?:ない|ません|せず|するな|[うくぐすつぬぶむる]な|禁止(?:する)?|厳禁|やめる|避ける)(?:こと)?[\s、。.!！）)」]*$/
// 英語は、同じ文の前のほうに否定があるとき。
const NEGATIVE_BEFORE = /\b(never|don'?t|do not|must not|should not|avoid)\b[^.\n]*$/i

const BLOCKED = [
  { kind: '指示の上書き', re: /(ignore|disregard|forget|override)\s+(all\s+|any\s+)?(of\s+)?(the\s+|your\s+)?(previous|prior|above|earlier|system|other)\s+(instructions?|prompts?|rules?|guidelines?)/gi },
  { kind: '指示の上書き', re: /(これまで|今まで|以前|上記|ここまで|ほか|他|システム)の?(指示|ルール|プロンプト|命令|決まり)(は|を)?(すべて|全て|全部)?(無視|忘れ|破棄|上書き|優先しない)/g },
  { kind: '指示の上書き', re: /system\s*prompt|システム\s*プロンプト/gi },
  { kind: '指示の上書き', re: /(ユーザー|利用者|人)の(指示|確認|承認|許可)(を|は)?(待たず|待たない|無視|省略|不要)/g, negatable: true },
  { kind: 'ガードの回避', re: /HARNESS_DISABLE|disableAllHooks|--no-verify|bypassPermissions|dangerously-skip-permissions|--dangerously|permissions?\.(allow|deny)|settings(\.local)?\.json/gi, negatable: true },
  { kind: 'ガードの回避', re: /(ガード|guard|hooks?|フック|ハーネス|harness|検証|verify|権限|承認|確認|許可)(を|は|の)?(回避|無効化|無効|外す|外して|止める|止めて|スキップ|迂回|バイパス|すり抜け|省略)/gi, negatable: true },
  { kind: 'ガードの回避', re: /(bypass|disable|skip|circumvent|turn\s+off|work\s+around)\s+(the\s+|any\s+)?(guards?|hooks?|harness|verification|permissions?|approvals?|confirmations?|checks?)/gi, negatable: true },
  { kind: '外部への送信', re: /https?:\/\//gi },
  { kind: '外部への送信', re: /\b(curl|wget)\b[^\n]*(\s-d\b|--data|\s-F\b|--form|\s-T\b|--upload|-X\s*(POST|PUT|PATCH)|\|\s*(ba|z)?sh\b)/gi },
  { kind: '外部への送信', re: /\b(nc|netcat|scp|sftp|ftp)\s+\S/gi },
  { kind: '外部への送信', re: /(外部|社外|サーバー?|webhook|Slack|メール|第三者|リモート)(に|へ|宛に)[^。\n]{0,20}(送信|送る|送って|アップロード|投稿|転送)/gi, negatable: true },
  { kind: '外部への送信', re: /\b(send|upload|post|exfiltrate|forward|email)\b[^.\n]{0,60}\bto\s+(an?\s+|the\s+)?(external|remote|third[- ]party|webhook|server|slack|e-?mail)/gi, negatable: true },
  { kind: '読み込み時の実行', re: /!`/g },
  { kind: '読み込み時の実行', re: /^\s*(?:`{3,}|~{3,})\s*!/gm },
  { kind: '読み込み時の実行', re: /^#!\s*\//gm },
  { kind: '読み込み時の実行', re: /<script\b/gi },
  { kind: '見えない記述', re: /<!--/g },
]

// 試用 Skill の本文だけに当てる。@ で始まるファイル参照は、ファイルの取り込みとして扱われうる。
const SKILL_ONLY = [
  { kind: 'ファイルの取り込み', re: /(?:^|[\s(（「])@[~.\w/-]+/gm },
]

// 書式用の文字（Cf：ゼロ幅、双方向の制御、ソフトハイフンなど）と、行・段落の区切り（Zl、Zp）。
// 文字そのものをソースに書かないよう、Unicode の分類で指定する。
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}]/u
// タブ・改行以外の制御文字（Cc。NEL を含む）。
const CONTROL = /[^\P{Cc}\t\n\r]/u
const LINE_BREAK = /[\r\n\p{Zl}\p{Zp}]/u

// 一致のあと、その文の終わりまでを取り出す。
function restOfSentence(text, from) {
  const end = text.slice(from).search(/[。\n]/)
  return end < 0 ? text.slice(from) : text.slice(from, from + end)
}

function excused(text, match) {
  const before = text.slice(0, match.index)
  if (NEGATIVE_BEFORE.test(before.slice(Math.max(before.lastIndexOf('。'), before.lastIndexOf('\n')) + 1))) return true
  return NEGATIVE_ENDING.test(restOfSentence(text, match.index + match[0].length))
}

export function scanText(raw, { skill = false } = {}) {
  const found = []
  // 書式用の文字（ゼロ幅、双方向の制御、ソフトハイフンなど）と、行の区切りに見える文字は拒否する。
  // 表示をごまかしたり、照合をすり抜けたりするのに使えるため。
  if (INVISIBLE.test(raw) || CONTROL.test(raw)) {
    found.push('制御文字や不可視の文字（ゼロ幅、ソフトハイフン、行区切りなど）が含まれています')
  }
  // 全角の英数字などを半角にそろえてから照合する。
  const text = raw.normalize('NFKC')
  for (const { kind, re, negatable } of [...BLOCKED, ...(skill ? SKILL_ONLY : [])]) {
    // すべての一致を調べる。1 つでも例外に当たらないものがあれば拒否する。
    for (const match of text.matchAll(re)) {
      if (negatable && excused(text, match)) continue
      found.push(`${kind}に当たる表現があります：「${match[0].trim().slice(0, 60)}」`)
      break
    }
  }
  return found
}

export const RULE_MAX_CHARS = 200

// 文章ルールは「命令形 1 行」。失敗票の ID は harness-note が後ろに付ける。
export function validateRuleText(raw) {
  const text = String(raw ?? '').trim().replace(/^[-*]\s+/, '')
  const errors = []
  if (!text) errors.push('ルールの本文が空です')
  if (LINE_BREAK.test(text)) errors.push('ルールは 1 行で書いてください（改行は使えません）')
  if (text.length > RULE_MAX_CHARS) errors.push(`ルールは ${RULE_MAX_CHARS} 文字までです（いま ${text.length} 文字）。詳しい手順は Skill にします`)
  errors.push(...scanText(text))
  return { ok: errors.length === 0, errors, text }
}

export const INCIDENT_REF = /^INC-\d{4}-\d{4}$/

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
  if (LINE_BREAK.test(desc)) errors.push('description は 1 行で書いてください')
  if (desc.length > SKILL_DESCRIPTION_MAX) errors.push(`description は ${SKILL_DESCRIPTION_MAX} 文字までです`)
  if (repoName && desc && !desc.includes(repoName)) {
    errors.push(`description に、どのリポジトリの作業で使うかを書いてください（リポジトリ名「${repoName}」を含める）`)
  }
  const text = String(body ?? '').replace(/\r\n/g, '\n').trim()
  if (!text) errors.push('本文が空です')
  if (/^---\s*$/m.test(text.split('\n')[0] ?? '')) errors.push('本文を --- で始めないでください（設定欄は name と description だけです）')
  if (text.split('\n').length > SKILL_MAX_LINES) errors.push(`本文は ${SKILL_MAX_LINES} 行までです`)
  if (text.length > SKILL_MAX_CHARS) errors.push(`本文は ${SKILL_MAX_CHARS} 文字までです`)
  errors.push(...new Set([...scanText(desc), ...scanText(text, { skill: true })]))
  return { ok: errors.length === 0, errors, description: desc, body: text }
}

export function renderSkill({ dirName, description, body }) {
  return `---\nname: ${dirName}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`
}
