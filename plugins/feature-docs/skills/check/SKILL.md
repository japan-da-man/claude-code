---
name: check
description: 要件定義書・設計書・機能マスタ・共通マスタの整合を機械で調べ、誤り（ファイルと決まり）と、要件定義書ごとの段階と次にやることを一覧にする。直さない。「要件と機能マスタは揃ってる？」「いまどの企画がどこまで進んでる？」「/feature-docs:check」と言われたときに使う。
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs status *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs check *) Bash(git rev-parse *)
---

# feature-docs:check: 整合と進み具合を調べる

**このスキルではファイルを変えない。**

対象のリポジトリ（`git rev-parse --show-toplevel`。`feature-docs/config.json` がなければ `/feature-docs:init` を勧めて終える）で、次の 2 つを実行する。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs check <repo>
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs status <repo>
```

`check` は誤りがあると終了コード 1 になるが、それは失敗ではない。

次の形で見せる。

1. 一行の結論（問題なし／誤り N 件・警告 M 件。要件定義書・設計書・機能マスタの数）。
2. 誤りと警告があれば表にする（ファイル、決まり、内容）。決まり（`rule`）のおもなもの:

   | 決まり | 意味 |
   | :- | :- |
   | `parse` / `filename` / `id` | 読めない、ファイル名や ID の形・重複 |
   | `status` | 段階の値が違う。機能マスタに planned を載せている |
   | `sections` | 要件定義書・設計書に必要な節がない |
   | `features` | 影響する機能が見つからない、新規なのにもう機能マスタにある、最後の PR で反映していない |
   | `pending` / `design` / `ui` | 設計の PR で付けるもの（pending、設計書、UI 案）が揃っていない、外し忘れ |
   | `internal` | 機能マスタに裏側の項目（API・データ・フラグ・イベントなど）がある |
   | `help` / `changelog` / `last_reviewed` | ga の機能にヘルプの項目や変更履歴がない |
   | `actors` / `new_actors` / `glossary` | アクターや用語が見つからない・重複 |

3. 進み具合：`status` の `requirements` を表にする（ID、題、段階、影響する機能、次にやること）。終わっていないもの（draft・approved・designed）を先に。
4. `vendored_check` が `stale` なら「`/feature-docs:init` で feature-docs/check.mjs を新しくできます」、`missing` なら「CI 用の check.mjs がありません」と添える。

直すよう頼まれたら、誤りの内容に合わせて直す（機能マスタに裏側の項目があれば設計書へ移す、など）。ただし承認済みの要件定義書の本文は変えない。
