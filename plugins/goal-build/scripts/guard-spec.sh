#!/usr/bin/env bash
# goal-build: PreToolUse(Edit|Write)。実行中の機能の SPEC.md（承認済み）の編集を止める。
# 他の機能の SPEC.md は対象外（次の機能の設計を邪魔しない）。
input=$(cat)
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
active="$dir/.goal-build/active"
[ -f "$active" ] || exit 0

if ! command -v jq >/dev/null 2>&1; then
  echo "goal-build: jq が必要です。jq を入れるか、/goal-build:finish でフローを終えてください。" >&2
  exit 2
fi

path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')
[ -n "$path" ] || exit 0
spec_dir=$(sed -n 1p "$active")
[ -n "$spec_dir" ] || exit 0

# シンボリックリンク（macOS の /tmp など）や相対パスの違いをならして比べる
resolve() {
  local p="$1"
  case "$p" in /*) ;; *) p="$dir/$p" ;; esac
  local parent
  parent=$(cd "$(dirname "$p")" 2>/dev/null && pwd -P) || { printf '%s' "$p"; return; }
  printf '%s/%s' "$parent" "$(basename "$p")"
}

if [ "$(resolve "$path")" = "$(resolve "$dir/$spec_dir/SPEC.md")" ]; then
  echo "goal-build: 承認済みの $spec_dir/SPEC.md は編集できません。仕様の変更が必要なら QUESTIONS.md の「実装」に blocking で書いて止まってください。" >&2
  exit 2
fi
exit 0
