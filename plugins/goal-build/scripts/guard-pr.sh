#!/usr/bin/env bash
# goal-build: PreToolUse(Bash)。フローの実行中だけ、gh pr create / gh pr merge を止める。
# push は止めない（main はブランチ保護で守る前提）。gh api 経由の PR 作成などは防げないので、
# 確実にしたいリポジトリでは permissions.deny とブランチ保護を併用する（DESIGN.md）。
input=$(cat)
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -f "$dir/.goal-build/active" ] || exit 0

if ! command -v jq >/dev/null 2>&1; then
  echo "goal-build: jq が必要です。jq を入れるか、/goal-build:finish でフローを終えてください。" >&2
  exit 2
fi

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

# gh の前の区切り: 行頭・; & | ( ` " ' / ・空白（bash -c "…"、$(…)、/usr/bin/gh なども拾う）
# gh と pr の間のオプション: -R owner/repo、--repo=owner/repo など
re=$(cat <<'EOF'
(^|[;&|(`"'/]|[[:space:]])gh([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+pr[[:space:]]+(create|merge)([^[:alnum:]_-]|$)
EOF
)

if printf '%s' "$cmd" | grep -Eq "$re"; then
  echo "goal-build: フローの実行中は PR の作成とマージを禁止しています。/goal-build:report で報告して止まってください。PR は人が /goal-build:finish のあとで作ります。" >&2
  exit 2
fi
exit 0
