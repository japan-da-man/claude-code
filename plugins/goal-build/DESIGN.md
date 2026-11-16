# goal-build の設計

要件定義が済んだ機能を、**設計 → `/goal` での自律的な実装 → AI レビュー → PR の手前での報告** まで Claude Code に進めさせ、PR の作成の前で止めるプラグイン。人が判断するのは **設計の承認（ゲート ①）** と **PR 前の確認（ゲート ②）** の 2 か所と、まとめて届く質問への回答だけ。

- 対象：Hono＋TypeScript と Python のバックエンド（モノレポも可）。チェックのコマンドを `check.sh` に閉じ込めるので、言語は問わない。
- スコープ外：PR の作成・マージ、デプロイ、要件定義そのもの（要件は spec-flow などで作る）。

## 流れ

| # | 段階 | 起動 | 成果物 | 人 |
| - | - | - | - | - |
| 0 | 初期設定 | `/goal-build:setup`（人） | `.goal-build/check.sh`・`config`、`.gitignore`、権限の提案 | 質問に答える |
| 1 | 設計 | `/goal-build:design <feature> <要件>`（人） | `docs/specs/<feature>/SPEC.md`・`QUESTIONS.md` | 回答し、SPEC.md を `approved` にする（ゲート ①） |
| 2 | 実装 | 新しいセッションで `/goal …`（テンプレートは design が示す） | コード・テスト・`PROGRESS.md` | blocked なら回答して同じ /goal を実行し直す |
| 3 | レビュー | implement が `spec-reviewer` を呼ぶ（最大 2 周） | `REVIEW.md` | — |
| 4 | 報告 | implement が `goal-build:report` を呼ぶ | `REPORT.md`・`PR_BODY.md` | 確認する（ゲート ②） |
| 5 | 終了 | `/goal-build:finish`（人） | 状態ファイルを消す | PR を作る |

設計で /goal を使わないのは、/goal の判定役が「質問して止まったターン」も未達と判定して続けさせ、推測で設計が進むため。実装では、/goal の条件に「blocked を報告した」「SPEC.md が approved でない」という逃げ道を入れて、質問で止まれるようにする。設計と実装でセッションを分けるのは、実装をまっさらなコンテキストと書かれた完了条件から始めるため。

spec-flow（要望 → 要件 → UI 案）の成果物 `docs/specs/<id>/` は、そのまま design の要件として読める。`<feature>` を同じ id にすると、同じディレクトリに SPEC.md が並ぶ。

## 構成

| コンポーネント | 呼び出し名 | 起動 | 役割 |
| --- | --- | --- | --- |
| setup | `/goal-build:setup` | 人のみ | チェックのコマンド、比較元ブランチ、`REVIEW_AGENT`、`.gitignore`、権限の提案 |
| design | `/goal-build:design` | 人のみ | SPEC.md と QUESTIONS.md「設計」 |
| implement | `goal-build:implement` | /goal の先頭で Claude | テスト先行の実装、事前確認、レビュー、止まるかの判定 |
| report | `goal-build:report` | implement から | REPORT.md・PR_BODY.md、state を reported に |
| finish | `/goal-build:finish` | 人のみ | 状態ファイルを消してフックを止める（中断にも使う） |
| spec-reviewer | `goal-build:spec-reviewer` | implement から | 仕様どおりかだけを見る、読むだけのレビュアー |
| hooks | — | 自動 | 下の「フック」 |

人が起動するスキルは `disable-model-invocation: true` にして、Claude が勝手に設計を始めたりフローを終えたりしないようにする。プラグインは他のプラグインに依存しない。一般品質のレビューは任意で、`.goal-build/config` の `REVIEW_AGENT` に名前（例 `dev-flow:reviewer`）があるときだけ spec-reviewer と並べて呼ぶ。

プラグインの settings では permissions を配れない（`agent` と `subagentStatusLine` だけが効く）ので、deny / allow は setup がプロジェクトの `.claude/settings.json` か `.claude/settings.local.json` に書く（人が選ぶ）。

## 状態

状態はすべてファイルに置き、会話が圧縮・クリアされても続きから再開できるようにする。

| ファイル | git | 中身 |
| --- | --- | --- |
| `.goal-build/check.sh` | コミット | テスト・型チェック・lint をまとめて実行する。1 つでも失敗したら非ゼロ |
| `.goal-build/config` | コミット | `BASE_BRANCH`、`REVIEW_AGENT` |
| `.goal-build/active` | 無視 | 1 行目：仕様ディレクトリ、2 行目：merge-base の SHA、3 行目：承認コミットの SHA |
| `.goal-build/state` | 無視 | `implementing` / `blocked` / `reported` |
| `.goal-build/stop-count`・`fail-total`・`fail-hash`・`last-pass` | 無視 | Stop フックの同じ失敗の回数・続けての失敗の回数・直前の失敗・最後に通ったときの署名 |
| `docs/specs/<feature>/*.md` | コミット | SPEC・QUESTIONS・PROGRESS・REVIEW・REPORT・PR_BODY |

遷移：（active なし）→ implement の初期化で `implementing` → 質問・チェックの連続失敗・check.sh がない で `blocked` → 回答後の再開で `implementing`（失敗の記録を消す）→ report で `reported` → finish で削除。`reported` のあと PROGRESS.md に修正タスクを足して /goal を実行し直すと `implementing` に戻る。追加のタスクがなければ、implement は「報告済みで、追加のタスクがないため何もしなかった」と報告して止まり、/goal もそれで終わる。

承認コミット（implement の初期化で SPEC.md と QUESTIONS.md をコミットしたもの。人がすでにコミットしていれば、SPEC.md を最後に変えたコミット）が、SPEC.md の書き換えを見つける基準になる。SPEC.md は作業ブランチで新しく作られるので、比較元ブランチとの差分では判定できない。blocked の間に人が SPEC.md を直した場合は、再開時に implement がそれを人の変更としてコミットし、承認コミットを取り直す（Claude が戻してしまわないように）。

## 質問のまとめ方

- 設計：design が「設計」節にまとめて止まる。
- 実装：implement が着手前に、出そうな質問をすべて「実装」節に書き出し、blocking があれば 1 回だけ止まる。実装中に出た blocking はその受け入れ基準を保留にして他を先に進め、終わった分のレビューも済ませてから、保留とレビューの残りをまとめて 1 回で止まる。
- non-blocking は推奨案で進め、仮定として PROGRESS.md と REPORT.md に残す。
- 書き方は [references/questions-format.md](references/questions-format.md)。

## フック

すべて `.goal-build/active` があるときだけ動く。設計フェーズや finish のあとは何もしない。作業ブランチへの push は止めない（main はブランチ保護で守る）。

| イベント | スクリプト | 動作 |
| --- | --- | --- |
| PreToolUse（Bash） | `guard-pr.sh` | `gh pr create`（別名 `new`）/ `gh pr merge` を exit 2 で止める。`gh -R o/r pr create`、`gh pr -R o/r create`、`bash -c "…"`、`$(…)`、`/usr/bin/gh` も拾う。パターンは `pr-pattern.ere` |
| PreToolUse（Edit / Write） | `guard-spec.sh` | 実行中の機能の SPEC.md と `.goal-build/check.sh` の編集を止める。他の機能の SPEC.md は対象外 |
| Stop | `run-checks.sh` | ① SPEC.md が承認コミットから変わっていれば止める（承認コミットが読めなくても止める）② `check.sh` が失敗していれば止める（前回通ってから中身が変わっていなければ省略）。check.sh がない・実行できなければ blocked。`blocked` では素通り、`reported` でもチェックする |
| SessionStart（startup / resume / clear / compact / fork） | `session-context.sh` | 状態ごとの案内と未完了タスクを注入。active が 24 時間以上前なら警告 |

決めたこと：

- **Stop は stdout の JSON（`decision: "block"`）で止める。** exit 2 と stderr だと、stdout が空で stderr に `No such file or directory` のような文言があるときにブロックにならない（hooks のドキュメント）。テストの出力にはこの文言がよく混ざる。
- **失敗回数は自前で数える。** Claude Code 側のブロック上限（連続 8 回）は Claude がツールを使うたびに数え直しになるので、DB が落ちている・元から落ちるテストがある、といった直らない失敗では止まれない。同じ失敗が 3 回続くか、中身を問わず 6 回続けて失敗したら `blocked` にする。同じ失敗かどうかは、アドレス（`0x…`）・UUID・数字・行の順番をならした出力のハッシュで比べる。中身が変われば「同じ失敗」は 1 に戻るので、テスト先行の途中ではすぐには止まらない。
- **中身が変わっていなければチェックを省く。** 一時的なインデックスに作業ツリーをすべて入れたツリーの SHA（未追跡ファイルの中身も含み、`.goal-build/` は除く）と、check.sh の中身のハッシュを署名にする。コミットしただけなら署名は変わらないので、二度走らない。
- **ガードには `onFailure: "block"`**（v2.1.295 以降）。ガードがタイムアウトや起動失敗を起こしても操作を通さない。Stop には効かないので付けない。jq がないときは、guard-pr は入力の JSON 全体を、guard-spec は素朴に取り出した `file_path` を見る（止めすぎることはあっても通しすぎない。finish の `rm` は通る）。
- **report は active を消さない。** 最終ターンも Stop フックでチェックするため。消すのは人が実行する finish だけ。
- **中断は `/goal clear` → finish の順。** ゴールが残ったまま状態を消すと、フックが外れた状態で作業が続く。

## /goal のテンプレート

design が `<feature>` を埋めて示す。判定役は会話しか読まず、コマンドもファイルも見ないので、条件は「会話に出た証拠」で書く。

```text
/goal 最初に Skill ツールで goal-build:implement を引数 <feature> で呼び、その手順に従って docs/specs/<feature> を実装する。
次のすべてが会話に示されたら達成：
(1) .goal-build/check.sh の最後の実行が exit 0 で、その出力を会話に出している
(2) 最新のレビュー結果で blocking の指摘が 0 件
(3) goal-build:report で REPORT.md と PR_BODY.md を作成したと報告している
ただし次のどれかを報告した場合も、その時点で終了とする：
- blocking な質問を QUESTIONS.md に書き .goal-build/state を blocked にした（保留した AC、2 周目に残ったレビュー指摘、check.sh の連続失敗を含む）
- SPEC.md が approved でないため開始しなかった
- 報告済みで、追加のタスクがないため何もしなかった
SPEC.md と既存テストの期待値は変更しない。PR の作成はしない。
40 ターンで打ち切る。
```

auto モードで動かす。使えない環境では `claude --permission-mode acceptEdits` と、setup が提案する allow を使う。

## レビュー

spec-reviewer は実装した会話を見ていない別コンテキストで動き、ツールは Read・Grep・Glob だけ（プラグインのサブエージェントでは `permissionMode` や `hooks` が無視されるので、制限は `tools` の許可リストで掛ける）。Bash を持たないので、差分は implement が渡す：SPEC.md、変更ファイルの一覧、既存テストの差分、承認コミットからの SPEC.md の差分、回答済みの QUESTIONS.md（SPEC.md を補う確定事項）、2 周目なら前回の REVIEW.md。

blocking にするのは、受け入れ基準の未実装・仕様との矛盾・仕様にあるエッジケースのテストの欠落・既存テストや SPEC.md の無断の書き換え・認可や入力検証の欠落だけ。スタイルは見ない。レビューは最大 2 周：1 周目の blocking を直し、2 周目でそれを確かめる。2 周目にも blocking があれば、直さずに blocked で人に返す（直したあとを確かめるレビューがないため）。non-blocking は REPORT.md に回す。

## リスクと制限

| リスク | 対策 |
| --- | --- |
| フックをかいくぐる PR 作成（`gh api` など）や、`echo "gh pr create"` のような誤検出 | 確実にしたいリポジトリでは deny とブランチ保護を併用する。誤検出は実害が小さいので許す |
| `check.sh` が 600 秒を超えるとフックが打ち切られ、終了が通る | check.sh を速く保つ。遅いテストは対象を絞るか、hooks.json の timeout を伸ばす |
| 状態ファイルが残り、別の作業でもフックが動く | finish で片付ける。起動時に 24 時間以上前の active を警告し、design も active があれば止まる |
| テストを通すために既存テストの期待値を書き換える | 既存テストの差分をレビュアーに渡し、REPORT.md に必ず載せる |
| トークン消費 | 40 ターンで打ち切る。`/goal` で経過と消費、`/usage` でサブエージェントの内訳を見る |
| jq がない環境 | setup で確かめる。ガードは jq なしでも動く（止めすぎることはある）。Stop フックは jq がないとチェックしない（警告だけ出す） |

## テスト

`node --test`（`tests/`）。一時ディレクトリに git リポジトリを作り、フックのスクリプトにダミーの入力 JSON を渡して確かめる：PR 作成のブロックと push の素通し、SPEC.md の保護（他の機能は対象外）、check.sh の失敗での停止と JSON の形、同じ失敗 3 回・続けて 6 回で blocked、アドレスや UUID だけが違う失敗を同じとみなすこと、中身が変わっていなければ省略（コミットだけなら省略、未追跡ファイル・壊れたシンボリックリンクがあっても変化を検知、check.sh の変更で再実行）、check.sh がない・実行できないときの blocked、SPEC.md の書き換えと承認コミットが読めないときの停止、jq がないときのガード、状態ごとの SessionStart の案内。

## 未決事項

- check.sh を全件実行にするか、変更ファイルに関係するテストだけにするか（いまはリポジトリごとに check.sh で決める）
- 機能ごとに worktree（`claude -w`）を使う運用にするか
- REPORT.md の仮定やレビュー指摘を、self-improve の改善候補の入力にするか
