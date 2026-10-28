---
name: finalize
description: 実装が終わった統合ブランチ（feature/REQ-xxxx）で、要件定義書の差分を機能マスタに反映し、ヘルプの項目と changelog を書き、新しいアクターと用語を足し、設計書の pending と未実装の印を外し、要件定義書を implemented にして、レビューガイドつきの最後の PR（統合ブランチ → main）を出す。PR のマージが最終レビュー。/feature-docs:build のあと、または「REQ-xxxx を仕上げて」「/feature-docs:finalize REQ-xxxx」と言われたときに使う。
argument-hint: "<REQ-xxxx>"
model: opus
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *) Bash(node feature-docs/check.mjs*) Bash(git fetch *) Bash(git status*) Bash(git rev-parse *) Bash(git switch *) Bash(git merge origin/*) Bash(git add *) Bash(git commit *) Bash(git diff*) Bash(git log *) Bash(gh pr list *) Bash(gh pr view *) Bash(date *) Bash(mkdir -p *)
---

# feature-docs:finalize: 機能マスタを更新して最後の PR へ

対象: $ARGUMENTS

1. 準備 → 2. 機能マスタ → 3. 共通マスタ → 4. 設計書と要件定義書 → 5. 確かめる → 6. 最後の PR、の順に進める。決まりの全体は `${CLAUDE_PLUGIN_ROOT}/DESIGN.md`。

機能マスタは **今提供している事実** の記録で、ヘルプ AI のソースになる。実装した結果を見て書く（要件定義書や設計書を写すのではない）。

## 1. 準備

- 対象のリポジトリは `git rev-parse --show-toplevel`。統合ブランチ `feature/REQ-xxxx` に switch し、`git fetch -q origin` のあと `git merge origin/main` で最新にする。
- `gh pr list --base feature/REQ-xxxx --state open` で、統合ブランチに向いた PR が残っていないことを確かめる。残っていれば、マージするか閉じるまで待つ。
- このリポジトリの確かめ方（型・lint・テスト、あれば Maestro）が統合ブランチで通ることを確かめる。
- バージョンを決める：アプリのバージョン（Expo なら `app.json` / `app.config.*` の `expo.version`、なければ `package.json`）。この機能が出るバージョンが分からなければ AskUserQuestion で聞く。
- 日付は `date +%Y-%m-%d` で取る。

## 2. 機能マスタ

要件定義書の `features.new` / `features.changed` ごとに。

- **新しい機能**：`${CLAUDE_PLUGIN_ROOT}/templates/feature.yaml` から `features/F-xxx-<name>.yaml`（設計書と同じ名前）を作る。
- **既存の機能**：要件定義書の「機能マスタへの差分」を反映する。
- どちらも：
  - `requirements` に REQ-xxxx を足す。`design_doc` に設計書のパス。
  - `actors`・`jobs`・`scenes`・`user_flows`・`limits` は、**実装した結果** で書く。利用者に見えることだけ（「サーバーに保存」「409 を返す」は書かない。「上限のメッセージが出る」と書く）。
  - `status`：フィーチャーフラグで一部の利用者にだけ出すなら `beta`、全員なら `ga`。分からなければ聞く。
  - `since_version`（新しい機能のとき）、`changelog` に `{version, date, change}` を足す（change は利用者向けの言葉で）、`last_reviewed` に今日。
  - `help`：`summary`（1〜2 文）、`how_to`（手順）、`limitations`（できないこと。ないなら []）、`faq`、`troubleshooting`、`synonyms`（ユーザーの呼び方。`glossary.yaml` の synonyms も見る）、`visibility`（ふつうは public）、`escalation`。ヘルプ AI はここしか読まないので、聞かれそうなことに答えられるように書く。
- 裏側の項目（api・data・feature_flag・events・screens など）は機能マスタに書かない（チェッカーが落とす）。

## 3. 共通マスタ

- 要件定義書の `new_actors` を `actors.yaml` に足す。
- 要件定義書で決めた新しい用語を `glossary.yaml` に足す（ヘルプ AI に出してよいものは `public: true`、取り違えやすいものは `not_to_confuse`）。

## 4. 設計書と要件定義書

- 設計書の `pending` から REQ-xxxx を外し、`> 未実装（REQ-xxxx）` の印を消す。設計書を **実装したとおり** に直す（実装メモに書いたずれを本文に反映し、実装メモは「設計からのずれ」の記録として残す）。
- 要件定義書の **フロントマターの `status` だけ** を `implemented` にする（本文は変えない）。

## 5. 確かめる

1. `node feature-docs/check.mjs` が通ること。誤りは直す。
2. ヘルプの書き出しを試す：`node feature-docs/check.mjs export-help --out <一時フォルダ>` を実行し、この機能の Markdown を読んで、利用者の質問に答えられる内容か、裏側の言葉が混ざっていないかを確かめる（一時フォルダはスクラッチの場所に作り、リポジトリには置かない）。
3. コミットして push する。

## 6. 最後の PR

`gh pr create --base main --head feature/REQ-xxxx --title "REQ-xxxx: <title>"`。本文は **レビューガイド** として書く（人が見るのはこの PR だけなので、ここで判断できるようにする）。

```markdown
## REQ-xxxx <title>

<何ができるようになったかを、利用者の言葉で 2〜3 行>

### 受け入れ条件と対応
| 受け入れ条件 | 対応する変更 | 確かめた方法 |
| --- | --- | --- |
| <> | <path:line> | <テスト名 / Maestro のフロー / 手で確認> |

### 見てほしいところ（危ない箇所）
- <データの移行、権限、課金、壊れやすい既存の処理など>

### 確認の手順
1. <EAS Update のプレビュー（QR / リンク）や、ビルドの入れ方>
2. <確かめる操作>

### 機能マスタとヘルプの差分
- F-xxx: <新規 / 変えた項目の要約>（ヘルプ: summary / how_to / limitations の要点）

### 設計からのずれ
- <なければ「なし」>

### 対応できなかったこと
- <なければ「なし」>

### 小さな PR
- <統合ブランチにマージした PR の一覧（gh pr list --base feature/REQ-xxxx --state merged）>

このPRのマージが最終レビューです。マージされると CI がヘルプ AI 用のナレッジを書き出します。
```

PR の URL と、レビューで特に見てほしい 1〜3 点を伝えて終える。
