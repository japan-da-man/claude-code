#!/usr/bin/env bash
# goal-build: PreToolUse(Edit|Write)。フローの実行中、次の編集を止める。
#   - 実行中の機能の SPEC.md（承認済み）。他の機能の SPEC.md は対象外（次の機能の設計を邪魔しない）
#   - .goal-build/check.sh（チェックを甘くして通すのを防ぐ）
input=$(cat)
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
active="$dir/.goal-build/active"
[ -f "$active" ] || exit 0

if command -v jq >/dev/null 2>&1; then
  path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')
else
  # jq がないときは file_path の値を素朴に取り出す（エスケープされた " を含むパスは対象外）
  path=$(printf '%s' "$input" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
fi
[ -n "$path" ] || exit 0
spec_dir=$(sed -n 1p "$active")

# シンボリックリンク（macOS の /tmp など）や相対パスの違いをならして比べる
resolve() {
  local p="$1"
  case "$p" in /*) ;; *) p="$dir/$p" ;; esac
  local parent
  parent=$(cd "$(dirname "$p")" 2>/dev/null && pwd -P) || { printf '%s' "$p"; return; }
  printf '%s/%s' "$parent" "$(basename "$p")"
}
target=$(resolve "$path")

if [ -n "$spec_dir" ] && [ "$target" = "$(resolve "$dir/$spec_dir/SPEC.md")" ]; then
  echo "goal-build: 承認済みの $spec_dir/SPEC.md は編集できません。仕様の変更が必要なら QUESTIONS.md の「実装」に blocking で書いて止まってください。" >&2
  exit 2
fi
if [ "$target" = "$(resolve "$dir/.goal-build/check.sh")" ]; then
  echo "goal-build: フローの実行中は .goal-build/check.sh を編集できません。チェックが合っていないと思うなら QUESTIONS.md の「実装」に blocking で書いて止まってください。" >&2
  exit 2
fi
exit 0
