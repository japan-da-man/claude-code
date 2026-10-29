---
name: check
description: デザインシステムの決まりを機械で調べ、トークンの誤り、コントラストの不足、根拠のつながりの切れ（trace-*）、廃止されたものの使用、未決の候補、段の進み具合、古くなった check.mjs を一覧にする。直さない。「デザインシステムに不備はない？」「原則とつながってる？」「/product-design:check」と言われたときに使う。
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs status *) Bash(git rev-parse *)
---

# product-design:check: デザインシステムを調べる

**このスキルではファイルを変えない。**

対象のアプリのリポジトリ（`git rev-parse --show-toplevel`。`design-system/design-system.json` がなければ、パスを尋ねるか `/product-design:init` を勧める）で、次を実行する。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs status <repo>
```

結果は JSON（`ok`・`violations`・`ds_errors`・`warnings`・`stale`・`deprecated`・`candidates`・`stages`・`next`）。`design-system.json` がない、v2 でない、`tokens.json` が読めないときはエラーになる。v1 なら `/design-system:check` を勧める。

次の形で見せる。

1. 一行の結論（不備なし／不備 N 件）と、段の進み具合（`stages`。`next` があれば「次は ○○ の段」）。
2. `ds_errors`（デザインシステムの中の不備）があれば、種類ごとにまとめて表にする。

   | 始まり | 意味 | 直し方 |
   | :- | :- | :- |
   | `tokens:` | `tokens.json` の形の誤り、必ずある役割の欠け | 値を DTCG の形に直す、役割を足す |
   | `コントラスト` | 文字と背景の組が 4.5:1（大きい文字は 3:1）に届かない | 色を濃くする（`swiftui.system` を付けた役割は、外して独自の値にする） |
   | `trace-missing` | 実在しない ID を指している | ID を直す |
   | `trace-none` | 根拠がない | 見出しの直後の行の `根拠:`、トークンの `from`、部品の `from` を書く |
   | `trace-layer` | 段を飛ばしている（トークンが `P` を指す、など） | `D` は `P` を、それより下は `D` を指す |

3. `deprecated`（廃止されたものを使っている）と `warnings`（`trace-orphan` の使われない原則、文字でない UI のコントラスト）があれば並べる。どちらも失敗ではない。
4. `candidates`（未決の候補）があれば、ファイルと画面を並べる。実装の前に決めるもの。
5. `stale`（古くなったもの）があれば並べる。`/product-design:update` で直る。

最後に、次にできることを伝える。

- デザインシステムの中の不備や、未決の候補は `/product-design:update` で直す・決める。
- 途中の段が残っていれば、`/product-design:init` で続きから進める。
