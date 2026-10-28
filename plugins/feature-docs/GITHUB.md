# GitHub の操作（gh が GraphQL を使えないとき）

`gh pr create`・`gh pr merge`・`gh pr list`・`gh pr checks`・`gh issue view` は GraphQL を使う。クラウドのセッション（claude.ai/code、Slack からの依頼、スケジュールタスク）では GraphQL が拒否され、`HTTP 403: GitHub GraphQL is not available` になる。そのときは REST の `gh api` で同じことをする。`{owner}/{repo}` は `gh repo view` ではなく `git remote get-url origin` から取る。

| やりたいこと | gh のコマンド | REST の代わり |
| --- | --- | --- |
| PR を作る | `gh pr create --base B --head H --title T --body-file F` | `gh api repos/{owner}/{repo}/pulls -f base=B -f head=H -f title=T -F body=@F --jq .html_url` |
| PR を見る | `gh pr view N` | `gh api repos/{owner}/{repo}/pulls/N` |
| PR のレビューのコメント | `gh pr view N --comments` | `gh api repos/{owner}/{repo}/pulls/N/reviews`・`…/pulls/N/comments`・`…/issues/N/comments` |
| 開いている PR の一覧 | `gh pr list --base B --state open` | `gh api "repos/{owner}/{repo}/pulls?base=B&state=open" --jq '.[].number'` |
| マージ済みの PR の一覧 | `gh pr list --base B --state merged` | `gh api "repos/{owner}/{repo}/pulls?base=B&state=closed&per_page=100" --jq '.[] \| select(.merged_at) \| "#\(.number) \(.title)"'` |
| head の SHA | `gh pr view N --json headRefOid` | `gh api repos/{owner}/{repo}/pulls/N --jq .head.sha` |
| チェックの結果 | `gh pr checks N` | `gh api repos/{owner}/{repo}/commits/{SHA}/check-runs --jq '.check_runs[] \| "\(.name) \(.status) \(.conclusion)"'` と `gh api repos/{owner}/{repo}/commits/{SHA}/status --jq .state` |
| マージ（squash） | `gh pr merge N --squash` | `gh api -X PUT repos/{owner}/{repo}/pulls/N/merge -f merge_method=squash` |
| マージされたか | `gh pr view N --json state` | `gh api repos/{owner}/{repo}/pulls/N --jq .merged` |
| Issue を読む | `gh issue view N --json title,body,comments` | `gh api repos/{owner}/{repo}/issues/N` と `gh api repos/{owner}/{repo}/issues/N/comments` |

## チェックの合格を待つ

`gh pr checks N --watch` の代わりに（gh が使えるときも、同じ判定で待つ）：

1. PR の head の SHA を取る（push し直したら取り直す）。
2. 30 秒おきに、その SHA の check-runs と status を見る。
3. **一覧が空なら、まだ CI が始まっていない**。合格とみなさない。3 分たっても空のままで、`.github/workflows/` に `pull_request` で動くワークフローがなく、status も `pending` のまま（ステータスが 1 件もない）なら、このリポジトリには PR のチェックがない。手元の確かめ方が通っていることを確かめてマージする。
4. check-runs がすべて `completed` で、`conclusion` がすべて `success`・`neutral`・`skipped` のどれか、かつ status が `pending`（件数 0）か `success` なら合格。
5. `failure`・`cancelled`・`timed_out`・`action_required` が 1 つでもあれば不合格。ログ（`gh api repos/{owner}/{repo}/actions/runs/{run_id}/logs` や check-run の `output`）を見て直す。
6. 30 分たっても終わらなければ、止めて伝える。

マージしたら、`merged` が true になったことを確かめてから次に進む。
