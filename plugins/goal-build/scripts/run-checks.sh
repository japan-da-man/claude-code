#!/usr/bin/env bash
# goal-build: Stop。フローの実行中、ターンを終える前に次を確かめ、だめなら終了を拒否する。
#   1. 承認済みの SPEC.md が承認コミットから変わっていないか（sed -i などでの書き換えも拾う）
#   2. .goal-build/check.sh が通るか（前回通ってから何も変わっていなければ省略）
# 止めるときは stdout の JSON（decision: block）を使う。exit 2 + stderr だと、stderr に
# 「No such file or directory」のような文言があるときにブロックにならないため（hooks のドキュメント）。
# 同じ失敗が 3 回続いたら state を blocked にして、人に回す（Claude Code 側の上限は、
# ツールを使うたびに数え直しになるので、直らない失敗では止まれない）。
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

# 1. 承認済みの SPEC.md
spec_dir=$(sed -n 1p "$root/active")
approved=$(sed -n 3p "$root/active")
spec="$spec_dir/SPEC.md"
if [ -n "$spec_dir" ] && [ -n "$approved" ]; then
  want=$(git rev-parse --verify --quiet "$approved:./$spec" 2>/dev/null)
  have=$(git hash-object "$spec" 2>/dev/null)
  if [ -n "$want" ] && [ "$want" != "$have" ]; then
    block "goal-build: $spec が承認時（$approved）から変わっています。git checkout $approved -- $spec で戻してください。仕様の変更が必要なら QUESTIONS.md の「実装」に blocking で書いて止まってください。"
  fi
fi

# 2. チェック
[ -x "$root/check.sh" ] || exit 0

# 前回通ってから変わっていなければ省略する。未追跡ファイルの中身も含め、状態ファイルは除く
exclude=":(exclude)$root"
sig=$( {
  git rev-parse HEAD 2>/dev/null
  git diff HEAD -- . "$exclude" 2>/dev/null
  git ls-files -o --exclude-standard -- . "$exclude"
  git -c core.quotepath=off ls-files -o --exclude-standard -- . "$exclude" | git hash-object --stdin-paths 2>/dev/null
} | git hash-object --stdin )
[ "$(cat "$root/last-pass" 2>/dev/null)" = "$sig" ] && exit 0

if out=$("./$root/check.sh" 2>&1); then
  printf '%s\n' "$sig" > "$root/last-pass"
  rm -f "$root/stop-count" "$root/fail-hash"
  exit 0
fi

# 同じ失敗が続いたときだけ数える。数字を除いて比べ、所要時間や行番号の違いは同じ失敗とみなす
fail_hash=$(printf '%s' "$out" | tr -d '0-9' | git hash-object --stdin)
if [ "$(cat "$root/fail-hash" 2>/dev/null)" = "$fail_hash" ]; then
  n=$(( $(cat "$root/stop-count" 2>/dev/null || echo 0) + 1 ))
else
  n=1
fi
printf '%s\n' "$fail_hash" > "$root/fail-hash"
printf '%s\n' "$n" > "$root/stop-count"
tail_out=$(printf '%s\n' "$out" | tail -n 80)

if [ "$n" -ge 3 ]; then
  echo blocked > "$root/state"
  block "goal-build: .goal-build/check.sh が同じ内容で 3 回続けて失敗したため、state を blocked にしました。原因と、人に決めてほしいことを QUESTIONS.md の「実装」に blocking で書いて止まってください。
--- check.sh の出力（末尾） ---
$tail_out"
fi
block "goal-build: .goal-build/check.sh が失敗しています。直してから終えてください（同じ失敗が 3 回続くと blocked になります: $n/3）。
--- check.sh の出力（末尾） ---
$tail_out"
