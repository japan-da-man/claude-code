---
name: design
description: マージ済み（approved）の要件定義書から、影響する機能の設計書（docs/design/F-xxx-*.md）・UI 案（docs/ui/REQ-xxxx/）・トラッキングプランを作り、設計の PR を出す。設計書には pending を付け、要件定義書を designed にする。PR のマージが設計と UI 案の承認。「REQ-xxxx を設計して」「UI 案を作って」「/feature-docs:design REQ-xxxx」と言われたとき、要件の PR がマージされたあとに使う。アプリのコードは書かない。
argument-hint: "<REQ-xxxx>"
model: opus
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *) Bash(node feature-docs/check.mjs*) Bash(git fetch *) Bash(git status*) Bash(git rev-parse *) Bash(git switch *) Bash(git show *) Bash(git add *) Bash(git commit *) Bash(git diff*) Bash(git log *) Bash(date *)
---

# feature-docs:design: 要件から設計と UI 案へ

対象: $ARGUMENTS

1. 準備 → 2. 調べる → 3. 設計書 → 4. トラッキングプラン → 5. UI 案 → 6. 全体図と ADR → 7. 確認 → 8. 設計の PR、の順に進める。**アプリのコードは書かない。** 決まりの全体は `${CLAUDE_PLUGIN_ROOT}/DESIGN.md`。

質問は必ず **AskUserQuestion** で出す（1 回に最大 4 問、おすすめを先頭に「(Recommended)」）。調べれば分かることは聞かない。

## 1. 準備

- 対象のリポジトリは `git rev-parse --show-toplevel`。`feature-docs/config.json` がなければ `/feature-docs:init` を案内して終える。
- 引数がなければ `node feature-docs/check.mjs status` で `approved` の要件定義書を探す。1 つならそれ、複数なら AskUserQuestion で選んでもらう。
- `git fetch -q origin` のあと、**origin/main にある** 要件定義書が `status: approved` であることを `git show origin/main:<path>` で確かめる。まだマージされていなければ、要件の PR のマージを待つよう伝えて終える（マージが承認なので、先に進まない）。
- `git switch -c design/REQ-xxxx-<name> origin/main` を作る。

## 2. 調べる

- 要件定義書の全文、`features.new` / `features.changed` の機能マスタと、既存の設計書（`docs/design/F-xxx-*.md`）
- `docs/architecture/`、関係する `docs/adr/`、`tracking/`
- コード：変える画面・API・データ・共通部品・テストを洗い出す。アプリが大きければ、Explore のサブエージェントを観点ごと（画面とルート / API とデータ / 共通部品・権限・通知 / テストと計測）に **1 回のメッセージで並列に** 起動し、結果の大事な点はファイルを開いて確かめる
- `design-system/design-system.json` があれば（design-system プラグイン）、その `docs` の文言の決まり（copy.md）と画面の型（patterns.md）を読む。UI 案と状態の表示はその範囲で作る

## 3. 設計書

影響する機能ごとに、設計書を作るか更新する。

- **新しい機能**：`${CLAUDE_PLUGIN_ROOT}/templates/design.md` から `docs/design/F-xxx-<name>.md`（番号は要件定義書の `features.new` のもの）。
- **既存の機能**：今の設計書を更新する。設計書がなければ、今の実装から今の設計を起こしてから、変更を足す。
- フロントマターの `pending` に `REQ-xxxx` を足す。変える・足す節には、見出しのすぐ下に `> 未実装（REQ-xxxx）` を置く（実装役はそこを「これから作る内容」として読む）。
- 書くこと：要件（EARS: When / While / If…then / The … shall）、利用者の流れごとのシーケンス図、状態遷移と各状態の表示、画面とルート、API（メソッド・パス・入出力のスキーマの場所・エラー）、データ（ER 図）、非機能・セキュリティ、リリース（フラグ、OTA かストア審査か）、受け入れ条件。
- 受け入れ条件は、要件定義書の受け入れ条件を **すべて** 技術的に具体化し、それぞれに確かめる手段（単体テストか、Maestro のフロー `.maestro/<feature>/<name>.yaml` のパス）を書く。
- 図は Mermaid（sequenceDiagram / stateDiagram-v2 / erDiagram / flowchart）。

## 4. トラッキングプラン

要件定義書の KPI を測るイベントを `tracking/F-xxx.yaml` に書く（`${CLAUDE_PLUGIN_ROOT}/templates/tracking.yaml`）。イベント名は「対象_動作」の snake_case、プロパティは 1 イベント 20 個まで。設計書の `tracking` にパスを書く。

## 5. UI 案（要件定義書が `ui: none` でなければ）

作業場は Claude Design、正本はリポジトリ。

1. **Claude Design を使えるとき**（claude.ai/design。デザインシステムは Claude Code の `/design-sync` でコードから取り込む）：要件定義書の「画面と状態」から、画面ごとに 2〜3 案を作ってもらう。案のリンクを AskUserQuestion の選択肢にして、どれで進めるかを決めてもらう。確定した案を **スタンドアロン HTML** で書き出し、`docs/ui/REQ-xxxx/` に置く。
2. **使えないとき**：自分で HTML のモックを書く。1 ファイル（`docs/ui/REQ-xxxx/index.html`）に、画面ごと・状態ごと（あり・空・読み込み中・エラー・オフライン）の見た目を並べ、案が複数あればタブで切り替える。スマホの幅（390px 程度）で描く。このセッションに Artifact ツールがあれば公開して URL を残す。決めた案以外は消すか、`alternatives/` に分ける。
3. `docs/ui/REQ-xxxx/README.md` に、採用した案と理由、Claude Design（または Artifact）の URL、設計書のどの画面に当たるかを書く。
4. 設計書のフロントマター `ui` と「画面」の表に、UI 案のパスを書く。

出力は HTML なので、React Native ではそのままコードにならない。実装では「見た目と意図」として読む、と README に書いておく。

## 6. 全体図と ADR

- システムの構成が変わるなら（新しいサービス、外部連携、データストア）、`docs/architecture/` の flowchart を更新する（Mermaid の C4 の書き方は GitHub で表示されないので使わない）。
- 大事な判断（技術の選択、データの持ち方、やらないと決めたこと）は `docs/adr/NNNN-<name>.md` に書き（`${CLAUDE_PLUGIN_ROOT}/templates/adr.md`）、設計書の `decisions` に足す。

## 7. 確認

1. 要件定義書の **フロントマターの `status` だけ** を `designed` にする（本文は変えない）。
2. `node feature-docs/check.mjs` が通ることを確かめる。誤りは直す。
3. 要点を見せる：機能ごとの変更の概要、新しい API とデータ、受け入れ条件と確かめる手段の対応、UI 案（パスと URL）、ADR、リスク。そして AskUserQuestion で「これで設計の PR を出す (Recommended) / 直してほしい / 止める」。

## 8. 設計の PR

コミットして `git push -u origin design/REQ-xxxx-<name>`、`gh pr create --title "design: REQ-xxxx <title>"`。本文：

```markdown
## 設計: REQ-xxxx <title>

- 要件定義書: docs/requirements/REQ-xxxx-<name>.md
- 設計書: <変更した設計書のパス>
- UI 案: docs/ui/REQ-xxxx/（<URL>）
- トラッキング: <パス>
- ADR: <あれば>

<変更の概要と、レビューで見てほしい判断を 3〜5 行で>

このPRのマージが設計と UI 案の承認です。マージ後に `/feature-docs:build REQ-xxxx` で実装を始めます。
```

PR の URL と次の一歩を伝えて終える。
