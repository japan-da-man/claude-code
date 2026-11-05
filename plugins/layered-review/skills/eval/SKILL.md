---
name: eval
description: 見逃したバグ（インシデント・revert・あとからの修正）を正解のケースにし、レビューの仕組み（REVIEW.md・プロンプト・モデル・モード）を変えたときに、全ケースでレビューを再生して採点し、前回と比べる。add でケースを足し（人が場所と内容を確かめる）、run で再生・判定・採点し、compare で見つけられなくなったバグを出し、status で全体を見る。「このバグを eval に足して」「REVIEW.md を変えたので測って」「/layered-review:eval」と言われたときに使う。
argument-hint: "add [<PR 番号 | コミット | revert>] [--clean] | run [--label <名前>] [--repeat <回数>] [--cases C-001,C-002] [--mode quick|standard|deep] | compare [<古い実行> <新しい実行>] | status"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *) Bash(node review/check.mjs*) Bash(git *) Bash(gh pr view *) Bash(gh pr diff *) Bash(gh pr list *)
---

# layered-review:eval: 見逃したバグでレビューを測る

引数: $ARGUMENTS

考え方は `${CLAUDE_PLUGIN_ROOT}/DESIGN.md` の「eval」。ケースの形は `${CLAUDE_PLUGIN_ROOT}/templates/case.json`。質問は **AskUserQuestion** で出す。

リポジトリは `git rev-parse --show-toplevel`（以降 `<repo>`）。`review/config.json` がなければ `/layered-review:init` を勧めて終える。

最初の語でやることを決める。なければ `status`。

## add: ケースを足す

正解は **人が場所と内容を確かめたものだけ**。エージェントは候補を作り、人が確かめる。

### バグのケース（既定）

1. 元を決める。引数か、ユーザーの説明から:
   - **revert**：戻されたコミットが、バグを入れた変更
   - **修正のコミット・PR**：修正で変えた行を、修正の親で `git blame -w -C <修正>^ -- <path>` し、その行を最後に変えたコミットを候補にする（いくつか出たら、修正の内容に近いものから並べる）
   - **インシデントの記録**（observability の `observability/incidents/` など）：書かれた原因・修正から、上の 2 つのどちらかにたどる
   - 何もなければ、`git log --grep='^fix\|^revert\|hotfix' -i --since=180.days` から候補を挙げて選んでもらう
2. バグを入れた変更 `head`（コミット）と、その親 `base` を決める。squash でマージした PR なら、そのコミット。マージコミットなら、1 つ目の親を `base` にする。候補が複数なら AskUserQuestion で選んでもらう。
3. `git show <head>` と修正の差分を読み、正解の下書きを作る。バグごとに:
   - `path` と `lines`：**`head` の時点** のファイルの行番号（修正のあとの行番号ではない）
   - `severity`（critical / high / medium / low）・`class`（バグの種類）・`description`（何が誤っているか）・`trigger`（どんな入力・状況で何が起きるか）
4. 下書きを見せ、AskUserQuestion で「この場所と内容で正しい (Recommended) / 直す（Other で）」を聞く。正しいと言った人の名前を `verified_by` に入れる（`git config user.name`）。**確かめてもらえないものはケースにしない。**
5. 番号は `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs eval new-id <repo>`。`review/evals/cases/<id>-<英小文字の短い名前>.json` に書く。`source` に元（修正・revert・インシデント）を書く。

### 問題のないケース（`--clean`）

誤指摘を測るため、問題のない変更も入れる（バグのケースの 1/3 くらいが目安）。マージから 30 日以上たち、そのあと修正も revert もされていない変更を選ぶ（`git log` で、その変更が触ったファイルにあとから `fix` が来ていないものを候補にする）。候補を見せて選んでもらい、`kind: "clean"`、`bugs: []` で書く。

### 確かめる

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs --repo <repo>
```

誤りがなければ、コミットするか尋ねる。

## run: 再生して採点する

レビューの仕組みを変えた **あと** に回す。変える前の実行がなければ、変える前の状態で先に 1 回回して基準にする（比べる相手がないと、良くなったか分からない）。

1. ケースを読む（`--cases` があればそれだけ）。数と、ケースごとに走らせるエージェントのおおよその数（モードで、探す人 1〜5 と確かめる人 1〜3）を見せ、時間と費用がかかることを伝えてから始める。`--repeat` の既定は 1。比べて採否を決めるときは 3 を勧める（LLM の結果はぶれるため）。
2. 実行の置き場所を作る:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs eval new-run <repo> --label <ラベル> --note "<何を変えたか>"
   ```
   ラベルは、変えたものが分かる名前（`baseline`・`review-md-v2`・`deep-for-high` など）。
3. ケースごとに（繰り返しの回数ぶん）:
   1. `head` が手元になければ `git fetch -q origin <head>`。それでもなければ、そのケースを飛ばして理由を記録する。
   2. `git worktree add --detach <一時フォルダ>/<id> <head>` で取り出す。
   3. モードは `--mode` があればそれ、なければ `node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs risk --repo <worktree> --config <repo>/review/config.json --base <base> --head <head> --json` の `mode`（本番と同じ決め方で、今の設定で測る）。
   4. `${CLAUDE_PLUGIN_ROOT}/references/procedure.md` の 1〜4 を進める。渡すもの: `repo_dir` は worktree、`range` は `<base>...<head>`、`scope: full`、`reported`・`previous_open` は空、`intent` は `head` のコミットのメッセージ。**`rules` は今の `<repo>` の REVIEW.md と CLAUDE.md**（測りたいのは今の決まり。worktree の中の古いものではない）。**正解（ケースの `bugs`）は渡さない。**
   5. ラベルを付けた指摘すべて（Important・Nit・Pre-existing）を、`<run>/findings/<id>.json`（2 回目からは `<id>.2.json`…）に配列で書く。各要素は `path`・`line`・`class`・`title`・`severity`・`label`・`trigger`。
   6. サブエージェント `layered-review:eval-judge`（なければ `general-purpose` に `${CLAUDE_PLUGIN_ROOT}/agents/eval-judge.md`）に、ケースの JSON と、その指摘と、`repo_dir`（worktree）を渡す。返ってきた JSON を `<run>/judgments/<id>.json`（同じ番号の付け方）に書く。
   7. `git worktree remove --force <一時フォルダ>/<id>`。
   ケースどうしは互いに関係ないので、並べて進めてよい（同時に走らせるエージェントの数は 10 くらいまでにする）。
4. 採点する:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs score <run> --repo <repo>
   ```
   誤り（判定の抜けや食い違い）が出たら、その判定だけやり直す。
5. 前の実行があれば、続けて `compare` を行う。

## compare: 前回と比べる

引数がなければ、`review/evals/runs/` の新しいほうから 2 つ（古いほうが先）。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs compare <古い実行> <新しい実行> --repo <repo>
```

次の形で見せる。

1. 一行の結論：悪化なし／悪化あり（`worse` の中身）。ケース数か繰り返しの回数が違えば、そのまま比べられないことを添える
2. 指標の差の表
3. **見つけられなくなったバグ**（重い順）。1 つでも critical / high があれば、その変更は採らないことを勧める
4. 見つけられるようになったバグ
5. 新しい実行で `real_unlisted`（正解にない本物の指摘）があれば、ケースに足すかを尋ねる。足すなら、add の 4 と同じく人に確かめてもらう

## status: 全体を見る

次を実行して、まとめて見せる。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs --repo <repo> --json
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs round stats <repo>
node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs outcomes --repo <repo> --json
```

- ケースの数（バグ・問題のない変更）と、最後の実行の採点（あれば `score`）
- 収束：通るまでの平均の往復回数、いちばん多く回したブランチ
- 指摘への対応：直した割合と、却下・意図どおり・問題にしなかったものの多い種類。却下や「問題にしなかった」が多い種類は、REVIEW.md の「指摘しないこと」に足す候補として挙げる
- ケースが 10 件未満なら、数字はまだぶれが大きいことを添える
