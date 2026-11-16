#!/usr/bin/env bash
# goal-build: SessionStart(startup|resume|clear|compact)。フローの実行中なら、状態ごとの案内を
# コンテキストに入れる（会話の圧縮やクリアで指示が抜けても、ファイルから続きを再開できるように）。
cat >/dev/null
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
root="$dir/.goal-build"
[ -f "$root/active" ] || exit 0

spec_dir=$(sed -n 1p "$root/active")
state=$(cat "$root/state" 2>/dev/null || echo implementing)

case "$state" in
  blocked)
    echo "[goal-build] $spec_dir は blocked です。$spec_dir/QUESTIONS.md の未回答の質問を確認してください。回答したら同じ /goal を実行し直すと、続きから再開します。"
    ;;
  reported)
    echo "[goal-build] $spec_dir は報告済み（PR 待ち）です。$spec_dir/REPORT.md を確認し、問題がなければ /goal-build:finish で終えてから PR を作ってください。直したい点があれば PROGRESS.md に追加タスクとして書き、同じ /goal を実行し直します。"
    ;;
  *)
    echo "[goal-build] 実行中: $spec_dir（state: $state）"
    if [ -f "$dir/$spec_dir/PROGRESS.md" ]; then
      todo=$(grep -E '^[[:space:]]*[-*] \[ \]' "$dir/$spec_dir/PROGRESS.md" | head -n 5 | sed -E 's/^[[:space:]]*[-*] \[ \] //' | awk 'NR > 1 { printf " / " } { printf "%s", $0 }')
      [ -n "$todo" ] && echo "未完了タスク: $todo"
    fi
    echo "ルール: 承認済みの SPEC.md は編集しない。PR の作成とマージはしない。続きは goal-build:implement の手順 2（再開）から。"
    ;;
esac

if [ -n "$(find "$root/active" -mmin +1440 2>/dev/null)" ]; then
  echo "[goal-build] 警告: 24 時間以上前に始めたフローが残っています。不要なら /goal clear のあと /goal-build:finish で片付けてください。"
fi
exit 0
