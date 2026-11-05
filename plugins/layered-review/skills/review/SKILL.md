---
name: review
description: 変更をいくつもの層でレビューする。変更の中身でリスク段階（low / standard / high）とレビューの深さを決め、PR の前ならテスト・型・lint を回して結果を見せ、観点別の複数のエージェントがバグを探し、別のエージェントの投票で誤検知を落とし、Important / Nit / Pre-existing に分けて出す。1 つの変更で回すのは決まった回数まで、2 回目からは前回からの差分だけを見る。直さない。「PR を出す前にレビューして」「PR 123 をレビューして」「/layered-review:review」と言われたときに使う。1 人のレビュアーで手早く見るなら dev-flow:review、UI の使いやすさは usable-ui:review。
argument-hint: "[PR 番号 | ブランチ] [--mode quick|standard|deep] [--base <ref>] [--no-verify] （省略時は未コミットを含む今の変更）"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *) Bash(git *) Bash(gh pr view *) Bash(gh pr diff *) Bash(gh api user*) Bash(gh repo view *)
---

# layered-review:review: 層でレビューする

引数: $ARGUMENTS

**このスキルではリポジトリのファイルを変えない。** 直すのは、ユーザーが頼んだあと。考え方の全体は `${CLAUDE_PLUGIN_ROOT}/DESIGN.md`、探して確かめる手順は `${CLAUDE_PLUGIN_ROOT}/references/procedure.md`。

質問は **AskUserQuestion** で出す。おすすめは先頭にして「(Recommended)」を付ける。

## 0. 対象を決める

- リポジトリは `git rev-parse --show-toplevel`。以降 `<repo>`。
- `review/config.json` がなければ既定値で進め、最後に `/layered-review:init` を勧める。
- base：`--base` があればそれ。なければ `git symbolic-ref -q refs/remotes/origin/HEAD`（なければ `origin/main`、それもなければ `main`）。
- **引数なし（PR の前）**：今のブランチの、base との分岐点から作業ツリーまで（未コミット・まだ追跡していないファイルも）。
  - `head`：作業ツリーが汚れていれば `git stash create`（作業ツリーは変えない。まだ追跡していないファイルは含まれないので、2 回目以降に差分だけを見る範囲から漏れうることを伝える）。きれいなら `git rev-parse HEAD`。
  - 往復の記録の名前は今のブランチ名。読むコードは作業ツリー。
- **PR 番号**：`gh pr view <N> --json number,title,body,baseRefName,headRefOid,author,isDraft` を読む。`git fetch -q origin <baseRefName> pull/<N>/head` のあと、base は `origin/<baseRefName>`、head は `headRefOid`。読むコードは `git worktree add --detach <一時フォルダ> <head>` で取り出す（今のブランチを切り替えない）。往復の記録の名前は `pr-<N>`。
- **ブランチ名**：PR 番号と同じように、そのブランチの先端を worktree で取り出す。
- 目的（`intent`）：PR の本文、ブランチのコミットのメッセージ、会話でのユーザーの説明。

## 1. リスク段階を決める

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs risk --repo <repo> --base <base> [--head <head>] [--author <login>] --json
```

PR の前なら `--head` を付けない（作業ツリーを見る）。作者は PR なら `author.login`、PR の前なら `gh api user -q .login`（取れなければ付けない）。

- `mode`：`--mode` があればそれ、なければ結果の `mode`。
- 段階・理由・人の承認（`human_approval`）は、最後の報告に出す。

## 2. 何回目かを確かめる

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs round begin <repo> --branch <名前> --head <head> --base <base との分岐点の SHA>
```

分岐点は `git merge-base <base> <head>`。

- `unchanged: true`：前回から変わっていない。前回の結果（`previous_open`）を見せて終える。くり返しても新しい指摘は出にくい。
- `over_cap: true`（決まった回数を超えた）：回し続けず、止まる。`previous_open` を種類（`class`）ごとにまとめて見せ、「直し方ではなく、方針（作り方・分け方）を見直す時期」と伝える。AskUserQuestion で「方針を見直す (Recommended) / 差分だけもう 1 回回す / 止める」を聞く。もう 1 回なら、そのまま 3 へ進む。
- `scope: diff`（2 回目から）：見るのは `diff_base` から `head` までの差分だけ。`reported` と `previous_open` を手順に渡す。rebase や force push で `diff_base` が `head` の祖先でなくなっていれば（`git merge-base --is-ancestor <diff_base> <head>` が失敗）、差分だけでは足りないので全体を見る。

## 3. PR の前の検証（引数なしのときだけ。`--no-verify` なら飛ばす）

「できました」ではなく、結果を見せるための層。

1. 回すコマンドは `review/config.json` の `checks`。空なら、`package.json` の scripts（`typecheck`・`lint`・`test` など）と `CLAUDE.md` から候補を探し、回してよいか 1 回だけ尋ねる（そのとき、`checks` に書けば次から聞かないことを添える）。
2. 順に回す。出力が長いものは、失敗した箇所と最後の数十行だけを残す（dev-flow の `test-runner` があれば任せてよい）。
3. 失敗があれば、どれが落ちたかを見せ、AskUserQuestion で「先に直す (Recommended) / このままレビューも続ける」を聞く。落ちていると、レビューの指摘の多くがその症状になるため。

## 4. 探して確かめる

`${CLAUDE_PLUGIN_ROOT}/references/procedure.md` のとおりに進める。渡すもの:

- `repo_dir`：PR の前なら `<repo>`、PR・ブランチなら worktree の場所
- `range`：1 回目は `<分岐点>...<head>`（PR の前は `<分岐点>`）、2 回目からは `<diff_base>...<head>`
- `mode`・`intent`・`scope`・`reported`・`previous_open`
- `rules`：`<repo>/REVIEW.md` と `<repo>/CLAUDE.md`（あるもの）

## 5. 記録する

手順の結果（指摘のラベル・`fp` と、`previous`）を一時ファイルに書いて記録する。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs round record <repo> --branch <名前> --head <head> --base <range の base> --file <tmp.json>
```

ファイルの形: `{"findings": [{"fp", "path", "line", "class", "title", "severity", "label"}], "previous": [{"fp", "status"}]}`。

`previous` で `fixed` になったものは、対応結果にも足す（`node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs outcome add <repo> --file <tmp.json>`、各行に `ref`（PR 番号かブランチ名）・`fp`・`class`・`severity`・`title`・`outcome: "fixed"`）。

## 6. 見せる

次の形で見せる。指摘は種類ごとにまとめ、場所をすべて挙げる（1 行ずつ直させない）。

```markdown
## 結論: Important N 件・Nit M 件・Pre-existing K 件（指摘なしなら「指摘なし」）

- リスク段階: high（認証・認可: api/src/auth/session.ts）→ レビュー: deep
- 人の承認: 作者以外の人の承認が要る（エージェントの承認は数えない）
- 往復: 2 / 3 回目（前回からの差分だけを見た）。前回の Important 2 件のうち 1 件が直った
- 検証: typecheck ✓ / test ✓ / lint ✗（3 件）

## Important
### 1. <種類>（high）— <題>
- 場所: `path:line`、`path:line`
- 状況: <どんな入力・状況で何が起きるか>
- 案: <直し方>

## Nit
- `path:line` — …

## Pre-existing（この変更より前から。直すかは別に決める）
- `path:line` — …

## 確かめきれなかったこと
- …

<details><summary>レビューの内訳</summary>探した人 N・確かめた人 M。書き方だけの指摘 a 件・重複 b 件・投票で落ちた c 件を除いた</details>
```

最後に 1 行、次の一歩を添える。

- Important があれば：「直すなら、種類ごとにまとめて直します。直したら、もう一度 `/layered-review:review` で差分だけを見ます」
- 決まった回数に近ければ：あと何回か
- Important がなければ：段階に応じて「作者が確かめてマージしてよい」か「作者以外の承認を頼む」か

## 7. PR に載せる（PR 番号のときだけ）

AskUserQuestion で「載せない (Recommended) / 要約と行ごとのコメントを載せる」を聞く。載せるなら、Important と Nit だけを、`event` を **`COMMENT`** にした 1 つのレビューで載せる（`APPROVE` と `REQUEST_CHANGES` は使わない。エージェントの承認は承認に数えないため）。

```bash
gh api repos/{owner}/{repo}/pulls/<N>/reviews --method POST --input <review.json>
```

`review.json` は `{"commit_id": "<head>", "event": "COMMENT", "body": "<結論の節>", "comments": [{"path": "...", "line": 42, "side": "RIGHT", "body": "**Important**（<種類>）…"}]}`。差分の外の行にはコメントを付けられないので、それは本文に書く。

## 8. 指摘への返事を記録する

ユーザーが指摘に「意図どおり」「問題にしない」「違う」と答えたら、理由とともに対応結果に足す（`outcome` は `intentional` / `ignored` / `rejected`）。`round record` の `previous` にも同じ `status` を入れて、次の回で出し直さないようにする。

## 片付け

worktree を作ったら、最後に `git worktree remove --force <一時フォルダ>` で消す。一時ファイルはスクラッチのフォルダ（なければ一時フォルダ）に置き、リポジトリには書かない。
