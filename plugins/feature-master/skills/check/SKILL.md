---
name: check
description: 機能マスタ（docs/features/）が決まった形になっているかを機械で調べ、エラー・警告（ファイル:行と決まり）、下書きの機能、古くなった一覧を出す。機能ファイルは直さない。「機能マスタを確かめて」「/feature-master:check」と言われたとき、機能ファイルを直したあとに使う。
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs check *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs index *) Bash(git rev-parse *)
---

# feature-master:check: 機能マスタを調べる

**調べるだけで、機能ファイルと actors.md・product.md は自分からは変えない**（直すのは、ユーザーに頼まれたときだけ）。変えてよいのは、確かめたうえでの一覧（`docs/features/README.md`）の作り直しだけ。

対象のリポジトリ（`git rev-parse --show-toplevel`。`docs/features/` がなければ、パスを尋ねるか `/feature-master:init` を勧める）で、次を実行する。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs check <repo>
```

結果は JSON（`ok`・`errors`・`warnings`・`drafts`・`stale`・`features`・`actors`）。エラーがあると終了コード 1 になるが、それは失敗ではない。

次の形で見せる。

1. 一行の結論（エラーなし／エラー N 件、機能と Actor の数）。
2. エラーと警告があれば、表にする（ファイル:行、決まり、内容）。決まりは次のとおり。

   | 決まり | 意味 |
   | :- | :- |
   | `frontmatter` | frontmatter（`---` で囲んだ部分）がない、または読めない |
   | `id` | `id` がない、ファイル名と違う、小文字の kebab-case でない |
   | `name`・`status`・`draft` | 機能名がない、状態が `提供中`・`開発中`・`廃止予定` のどれでもない、`draft` が true / false でない |
   | `actors` | Actor がない、`actors.md` にない Actor を指している、`actors.md` の表の誤り。使われていない Actor は警告 |
   | `product` | `product.md`（全体の前提）がない |
   | `related` | 関連機能の機能ファイルがない、自分自身を指している。`note` がない・重複は警告 |
   | `section` | `## 概要` か `## 利用シーン` がない・空。知らない見出し・重複は警告 |
   | `scene` | 利用シーンが「- 状況 → したいこと」の箇条書きになっていない（警告） |
   | `premise` | 機能ファイルの前提が、`product.md` の全体の前提を繰り返している（警告。機能ファイルから消す） |
   | `key` | frontmatter の知らない項目（警告） |

3. `drafts`（`draft: true` の機能）があれば並べる。意図をまだ確かめていない機能で、ファイルを直して `draft: true` を消せば下書きでなくなる。
4. `stale`（一覧が古い）があれば、AskUserQuestion で一覧を作り直してよいか尋ねる（作り直す（Recommended）／今はしない）。作り直すなら次を実行し、作り直したことを伝える（コミットはしない）。

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs index <repo>
   ```

   エラーがあるあいだは一覧と比べないので、`stale` は出ない。

最後に、エラーや警告を直すよう頼まれたら、機能ファイルの書き方（`${CLAUDE_PLUGIN_ROOT}/DESIGN.md` の「形式」）に合わせて直し、もう一度このチェックを実行する。意図（利用シーン・大事にしていること・前提・想定していないこと）を変えることになる直しは、勝手に書かずにユーザーに確かめる。
