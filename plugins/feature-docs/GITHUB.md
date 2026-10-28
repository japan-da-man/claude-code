# GitHub の操作（gh が GraphQL を使えないとき）

`gh pr create`・`gh pr merge`・`gh pr list`・`gh pr checks`・`gh issue view` は GraphQL を使う。クラウドのセッション（claude.ai/code、Slack からの依頼、スケジュールタスク）では GraphQL が拒否され、`HTTP 403: GitHub GraphQL is not available` になる。そのときは REST の `gh api` で同じことをする。`{owner}/{repo}` は `gh repo view` ではなく `git remote get-url origin` から取る。

| やりたいこと | gh のコマンド | REST の代わり |
| --- | --- | --- |
| PR を作る | `gh pr create --base B --head H --title T --body-file F` | `gh api repos/{owner}/{repo}/pulls -f base=B -f head=H -f title=T -F body=@F --jq .html_url` |
| PR を見る | `gh pr view N` | `gh api repos/{owner}/{repo}/pulls/N` |
| 開いている PR の一覧 | `gh pr list --base B --state open` | `gh api "repos/{owner}/{repo}/pulls?base=B&state=open" --jq '.[].number'` |
| マージ済みの PR の一覧 | `gh pr list --base B --state merged` | `gh api "repos/{owner}/{repo}/pulls?base=B&state=closed&per_page=100" --jq '.[] \| select(.merged_at) \| "#\(.number) \(.title)"'` |
| チェックの結果 | `gh pr checks N` | `gh api repos/{owner}/{repo}/commits/{head の SHA}/check-runs --jq '.check_runs[] \| "\(.name) \(.status) \(.conclusion)"'` |
| マージ（squash） | `gh pr merge N --squash` | `gh api -X PUT repos/{owner}/{repo}/pulls/N/merge -f merge_method=squash` |
| 自動マージを予約 | `gh pr merge N --auto --squash` | `gh api -X PUT repos/{owner}/{repo}/pulls/N/ccr/auto_merge -f merge_method=squash`（クラウドのセッション専用の経路） |
| Issue を読む | `gh issue view N --json title,body,comments` | `gh api repos/{owner}/{repo}/issues/N` と `gh api repos/{owner}/{repo}/issues/N/comments` |

チェックの合格を待つときは、check-runs を 30 秒おきに見て、すべて `completed` になるまで待つ（`gh pr checks --watch` の代わり）。
