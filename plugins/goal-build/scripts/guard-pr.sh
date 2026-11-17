#!/usr/bin/env bash
# goal-build: PreToolUse(Bash)。フローの実行中だけ、gh pr create（別名 new）/ gh pr merge を止める。
# push は止めない（main はブランチ保護で守る前提）。gh api 経由の PR 作成などは防げないので、
# 確実にしたいリポジトリでは permissions.deny とブランチ保護を併用する（DESIGN.md）。
input=$(cat)
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -f "$dir/.goal-build/active" ] || exit 0

# jq があればコマンドだけを取り出す。なければ入力の JSON 全体を見る（止めすぎることはあっても、
# 通しすぎることはない。jq がなくても finish の rm などは通る）
if command -v jq >/dev/null 2>&1; then
  cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
else
  cmd=$input
fi

# パターンは pr-pattern.ere に置く（macOS の bash 3.2 は、$( ) の中のヒアドキュメントにある
# 対にならない引用符を読み違えるため）。gh の前の区切り: 行頭・; & | ( ` " ' / ・空白
# （bash -c "…"、$(…)、/usr/bin/gh なども拾う）。gh と pr の間、pr と create の間のオプション
# （-R owner/repo、--repo=owner/repo など）も許す
pattern="$(dirname "$0")/pr-pattern.ere"

if printf '%s' "$cmd" | grep -Eqf "$pattern"; then
  echo "goal-build: フローの実行中は PR の作成とマージを禁止しています。/goal-build:report で報告して止まってください。PR は人が /goal-build:finish のあとで作ります。" >&2
  exit 2
fi
exit 0
