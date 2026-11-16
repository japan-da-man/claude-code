#!/usr/bin/env bash
# goal-build: Stop。フローの実行中、ターンを終える前に次を確かめ、だめなら終了を拒否する。
#   1. 承認済みの SPEC.md が承認コミットから変わっていないか（sed -i などでの書き換えも拾う）
#   2. .goal-build/check.sh が通るか（前回通ってから中身が何も変わっていなければ省略）
# 止めるときは stdout の JSON（decision: block）を使う。exit 2 + stderr だと、stderr に
# 「No such file or directory」のような文言があるときにブロックにならないため（hooks のドキュメント）。
# Claude Code 側のブロック上限は、ツールを使うたびに数え直しになるので、直らない失敗では止まれない。
# そこで自前で数え、同じ失敗が 3 回、または中身を問わず 6 回続いたら state を blocked にして人に回す。
cat >/dev/null   # 入力は使わない（読み切って閉じる）
cd "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || exit 0
root=.goal-build
[ -f "$root/active" ] || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
if ! command -v jq >/dev/null 2>&1; then
  echo "goal-build: jq がないため、終了前のチェックをしていません。" >&2
  exit 1
fi

state=$(cat "$root/state" 2>/dev/null || echo implementing)
[ "$state" = blocked ] && exit 0

block() {
  jq -n --arg r "$1" '{decision: "block", reason: $r}'
  exit 0
}
to_blocked() {
  echo blocked > "$root/state"
  block "$1"
}

# 1. 承認済みの SPEC.md
spec_dir=$(sed -n 1p "$root/active")
approved=$(sed -n 3p "$root/active")
spec="$spec_dir/SPEC.md"
if [ -n "$spec_dir" ] && [ -n "$approved" ]; then
  want=$(git rev-parse --verify --quiet "$approved:./$spec" 2>/dev/null)
  if [ -z "$want" ]; then
    block "goal-build: .goal-build/active の 3 行目（$approved）から $spec を読めません。承認コミットの SHA を書き直してください（例: git log -1 --format=%H -- $spec）。"
  fi
  if [ "$want" != "$(git hash-object "$spec" 2>/dev/null)" ]; then
    block "goal-build: $spec が承認時（$approved）から変わっています。あなた（Claude）が変えたのなら git checkout $approved -- $spec で戻してください。人が直したものなら、.goal-build/state を blocked にして、その旨を報告して止まってください（再開時に implement が承認を取り直します）。"
  fi
fi

# 2. チェック
if [ ! -f "$root/check.sh" ] || [ ! -x "$root/check.sh" ]; then
  to_blocked "goal-build: .goal-build/check.sh がないか、実行できない（chmod +x がない）ため、チェックできません。state を blocked にしました。その旨を報告して止まってください（人が /goal-build:setup で直します）。"
fi

# 前回通ってから中身が変わっていなければ省略する。一時的なインデックスに作業ツリーをすべて
# 入れてツリーの SHA を取る（未追跡ファイルの中身も含む。コミットしただけなら同じ SHA になる）。
# 状態ファイルは除き、check.sh の中身は別に足す
tmp_index=$(mktemp "${TMPDIR:-/tmp}/goal-build-index.XXXXXX") || exit 0
trap 'rm -f "$tmp_index"' EXIT
real_index=$(git rev-parse --git-path index)
if [ -f "$real_index" ]; then cp "$real_index" "$tmp_index"; else rm -f "$tmp_index"; fi
GIT_INDEX_FILE=$tmp_index git add -A -- . ":(exclude)$root" >/dev/null 2>&1
tree=$(GIT_INDEX_FILE=$tmp_index git write-tree 2>/dev/null)
sig="$tree-$(git hash-object "$root/check.sh")"
[ -n "$tree" ] && [ "$(cat "$root/last-pass" 2>/dev/null)" = "$sig" ] && exit 0

if out=$("./$root/check.sh" 2>&1); then
  [ -n "$tree" ] && printf '%s\n' "$sig" > "$root/last-pass"
  rm -f "$root/stop-count" "$root/fail-total" "$root/fail-hash"
  exit 0
fi

# 同じ失敗かどうかは、揺れやすい部分（アドレス・UUID・数字・行の順番）をならしてから比べる
fail_hash=$(printf '%s\n' "$out" \
  | sed -E 's/0x[0-9a-fA-F]+/0x/g; s/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/UUID/g' \
  | tr -d '0-9' | LC_ALL=C sort | git hash-object --stdin)
if [ "$(cat "$root/fail-hash" 2>/dev/null)" = "$fail_hash" ]; then
  same=$(( $(cat "$root/stop-count" 2>/dev/null || echo 0) + 1 ))
else
  same=1
fi
total=$(( $(cat "$root/fail-total" 2>/dev/null || echo 0) + 1 ))
printf '%s\n' "$fail_hash" > "$root/fail-hash"
printf '%s\n' "$same" > "$root/stop-count"
printf '%s\n' "$total" > "$root/fail-total"
tail_out=$(printf '%s\n' "$out" | tail -n 80)

if [ "$same" -ge 3 ] || [ "$total" -ge 6 ]; then
  to_blocked "goal-build: .goal-build/check.sh が続けて失敗したため（同じ内容で $same 回、合わせて $total 回）、state を blocked にしました。原因と、人に決めてほしいことを QUESTIONS.md の「実装」に blocking で書いて止まってください。
--- check.sh の出力（末尾） ---
$tail_out"
fi
block "goal-build: .goal-build/check.sh が失敗しています。直してから終えてください（同じ失敗 $same/3、続けての失敗 $total/6 で blocked になります）。
--- check.sh の出力（末尾） ---
$tail_out"
