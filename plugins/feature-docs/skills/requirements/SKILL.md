---
name: requirements
description: 企画（やりたいこと、Issue）を、AI との一問一答で要件定義書（docs/requirements/REQ-xxxx-*.md）にまとめ、要件の PR を作る。既存の機能マスタ・アクター・用語を読んでから聞き、既存の機能への変更は差分で書く。PR のマージが要件の承認。「〇〇できるようにしたい」「この企画を要件定義して」「/feature-docs:requirements <企画>」と言われたとき、進行中の要件定義を続けるときに使う。設計とコードは書かない。
argument-hint: "<やりたいこと> | <Issue 番号か URL> | <REQ-xxxx>"
model: opus
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *) Bash(node feature-docs/check.mjs*) Bash(git fetch *) Bash(git pull --ff-only*) Bash(git status*) Bash(git rev-parse *) Bash(git switch *) Bash(git add *) Bash(git commit *) Bash(git diff*) Bash(git log *) Bash(gh issue view *) Bash(date *) Bash(git remote get-url *) Bash(git push *) Bash(gh pr *) Bash(gh api *)
---

# feature-docs:requirements: 企画から要件定義書へ

企画: $ARGUMENTS

1. 準備 → 2. 前提を読む → 3. 一問一答 → 4. 書く → 5. 確認 → 6. 要件の PR、の順に進める。**書くのは要件定義書だけ。** 設計（API・データ・画面の見た目）とコードはここでは決めない。決まりの全体は `${CLAUDE_PLUGIN_ROOT}/DESIGN.md`。

質問は必ず **AskUserQuestion** で出す。本文に質問を並べない。

GitHub の操作（`gh pr …`・`gh issue view`）が `GitHub GraphQL is not available` で失敗したら、`${CLAUDE_PLUGIN_ROOT}/GITHUB.md` の REST の書き方に切り替える。

## 1. 準備

- 対象のリポジトリは `git rev-parse --show-toplevel`。`feature-docs/config.json` がなければ、先に `/feature-docs:init` を案内して終える。
- `git fetch -q origin`。手元の main が遅れていれば、pull してよいか尋ねて `git pull --ff-only`。
- 引数で分ける：
  - **`REQ-xxxx`**：その要件定義書を再開する（レビューの指摘を直すときも）。ブランチ `req/REQ-xxxx-*` があれば `git switch` して `git pull` する。承認済みかどうかは **origin/main の版** で決める（`git show origin/main:<path>` が `approved` 以降なら承認済み）。承認済みなら書き換えないことを伝える（変えたいなら、新しい要件定義書を起こして `supersedes` で参照する）。PR の中で `approved` にしてあるだけ（まだマージされていない）なら、同じブランチで直して push する。PR が開いていれば、レビューのコメントを読んでから直す。
  - **Issue の番号か URL**：`gh issue view <番号> --json number,title,body,author,comments` で読み、企画として使う。
  - **それ以外**：その文を企画の原文として使う。空なら、何をしたいかを尋ねる。
- 新しく始めるときは、`git fetch -q origin` のあとに `node feature-docs/check.mjs next-id req` で番号を取り（作業ツリーと、git のすべてのブランチ（origin のものも）の番号を避ける）、英語 2〜4 語の名前（kebab-case）を決めて、`git switch -c req/REQ-xxxx-<name> origin/main` を作る。

## 2. 前提を読む

質問の前に、次を読む（聞かなくて済むことを増やすため）。

- `docs/product/overview.md`、`actors.yaml`、`glossary.yaml`
- `features/*.yaml` のすべての `id`・`name`・`help.summary`・`actors`・`scenes`（関係しそうな機能は全体を読む）
- `docs/requirements/` の最近の要件定義書（同じ機能を触っていないか、`status` が implemented 以外のもの）
- 関係しそうな画面のコード（今どう動くかは、聞かずにコードで確かめる）

## 3. 一問一答

次の **観点** の順に、全部埋まるまで AskUserQuestion で聞く。

- 1 回に出すのは、答えが前の答えに依存しない質問だけ（最大 4 問）。選択肢をつけ、おすすめは先頭にして「(Recommended)」を付ける。
- 選択肢は、既存の機能マスタ・アクター・用語から作る（例：「対象は A-member（会員）」「F-012 お気に入り を変える」）。
- **答えによって要件が変わることだけ** を聞く。決めきれないものは「未決事項」に入れて先に進む。
- ユーザーが「もう十分」と言ったら打ち切り、残りは仮定として未決事項に書く。

| # | 観点 | 決めること |
| - | - | - |
| 1 | 背景と課題 | 誰が何に困っているか、なぜ今か |
| 2 | 目的とKPI | 何が良くなれば成功か。KPI の定義・目標値・期間 |
| 3 | 誰が・いつ | アクター（既存か新規か）、JTBD（〜なとき、〜したい。そうすれば〜）、利用シーン（いつ・どこで・頻度・状態） |
| 4 | 影響する機能 | 新しい機能か、既存の機能（F-xxx）の変更か。両方のこともある |
| 5 | 利用者の流れ | 正常な流れ、代わりの流れ、うまくいかないとき（空・上限・圏外・権限なし・途中でやめる）に利用者に見えること |
| 6 | スコープ / 非ゴール | やること、やらないこと |
| 7 | 受け入れ条件 | 利用者から見た Given / When / Then。5 の流れごとに 1 つ以上 |
| 8 | 画面と状態 | 画面の一覧と状態（あり・空・読み込み中・エラー・オフライン）。**見た目は決めない**（設計の段階で UI 案を作る） |
| 9 | 制約 | 期限、対象のプラン、規約・法務 |

新しい機能には、ここで番号を振る：`node feature-docs/check.mjs next-id feature`（機能マスタ・設計書と、要件定義書の本文にある番号を、すべてのブランチから数える。まだ push していないほかの人の企画とはぶつかることがあるが、そのときは後からマージする PR の CI が重複で落ちるので、番号を振り直す）。

## 4. 書く

`${CLAUDE_PLUGIN_ROOT}/templates/requirements.md` から `docs/requirements/REQ-xxxx-<name>.md` を書く。聞きながら少しずつ書いてよい（中断しても再開できる）。

- フロントマター：`id`・`title`・`status: draft`・`requested_by`・`priority`・`issue`・`features.new` / `features.changed`・`actors`・`new_actors`（新しいアクターだけ。id・name・kind・description）。画面が変わらないなら `ui: none`。
- **既存の機能への変更は差分で書く**（「F-012 の scenes に『…』を足す」「F-012 の user_flows UF-012-1 の 2 番目を『…』に変える」）。機能マスタそのものは変えない（最後の PR で反映する）。
- 利用者の流れと受け入れ条件には **システムの内部の処理を書かない**（「サーバーに保存」ではなく「一覧に出る」）。
- 用語は `glossary.yaml` の言い方にそろえる。新しい用語は本文で定義し、未決事項に「glossary に足す」と書く。
- 書いたら `node feature-docs/check.mjs` で形を確かめる（draft は形だけ調べる）。

## 5. 確認

要件定義書の要点（目的と KPI、対象、影響する機能、流れ、受け入れ条件の数、未決事項）を 10 行ほどで見せ、AskUserQuestion で聞く。

- 「これで要件の PR を出す」(Recommended)
- 「直してほしい」（Other で内容を）
- 「下書きのまま止める」

止めるときは `status: draft` のままコミットし、再開の方法を伝える：「`/feature-docs:requirements REQ-xxxx` で続けられます」。

## 6. 要件の PR

1. `status: approved` にする（**マージされることが承認**。PR の中で approved にしておく）。
2. `node feature-docs/check.mjs` が通ることを確かめる。誤りは直す（節の不足、存在しない機能 ID やアクターなど）。
3. コミットして `git push -u origin req/REQ-xxxx-<name>`、`gh pr create --title "REQ-xxxx: <title>"`。本文：

   ```markdown
   ## 要件定義: REQ-xxxx <title>

   <目的と KPI を 2〜3 行で>

   - 影響する機能: 新規 F-xxx / 変更 F-yyy
   - 対象: <アクター>
   - 受け入れ条件: N 件
   - 未決事項: <あれば>

   このPRのマージが要件の承認です。マージ後に `/feature-docs:design REQ-xxxx` で設計と UI 案を作ります。

   Refs #<Issue 番号>
   ```

4. PR の URL と、次の一歩（レビューしてマージ → `/feature-docs:design REQ-xxxx`）を伝えて終える。
