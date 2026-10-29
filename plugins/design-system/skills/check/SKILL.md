---
name: check
description: アプリのコードがデザインシステムの決まりに沿っているかを機械で調べ、違反（ファイル:行と決まり）と、古くなったもの（Tokens.swift・check.mjs・shoot.mjs・Artifact）を一覧にする。直さない。「デザインシステムに沿ってる？」「見た目の決まりを守れているか調べて」「/design-system:check」と言われたときに使う。
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs status *) Bash(git rev-parse *)
---

# design-system:check: 決まりに沿っているかを調べる

**このスキルではファイルを変えない。**

対象のアプリのリポジトリ（`git rev-parse --show-toplevel`。`design-system/design-system.json` がなければ、パスを尋ねるか `/design-system:init` を勧める。`version` が 2 以上なら、`/product-design:check` を勧めて終える）で、次を実行する。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs status <repo>
```

結果は JSON（`ok`・`violations`・`stale`・`allowed`・`files`）。違反があると終了コード 1 になるが、それは失敗ではない。

次の形で見せる。

1. 一行の結論（違反なし／違反 N 件、調べたファイルの数）。
2. 違反があれば、表にする（ファイル:行、決まり、該当箇所、代わりに使うもの）。決まりは次のとおり。

   | 決まり | 意味 |
   | :- | :- |
   | `color` | 直書きの色（`DS.Color.*` を使う） |
   | `font` | 直書きの文字（`DS.Font.*` を使う） |
   | `spacing` | 直書きの余白・角丸（`DS.Space.*`・`DS.Radius.*` を使う） |
   | `control` | 部品を通さないボタン・入力欄（`DSButton` などを使う） |
   | `tokens` | `tokens.json` の誤り、または `Tokens.swift` が `tokens.json` と合っていない |

3. `stale`（古くなったもの）があれば並べる。どれも `/design-system:update` で直る。
4. `allowed`（`// design-system: allow` で通した箇所）が 0 でなければ、その数。

最後に、次にできることを伝える。

- アプリのコードの違反は、部品とトークンに置き換えれば直る（直すよう頼まれたら、デザインシステムのファイルは変えずに、アプリのコードだけを直す）。
- デザインシステムに足りない部品やトークンがあって違反になっているなら、`/design-system:update` で足す。
