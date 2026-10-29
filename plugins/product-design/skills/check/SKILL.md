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

1. 一行の結論と、段の進み具合。`status` は `--strict` なしで動くので、`ok` はデザインシステムの中の不備があっても `true` になる。**結論は `ok` ではなく、`ds_errors` と `violations` の件数で出す**（「不備なし」か「不備 N 件」）。段は `stages` を並べ、`next` があれば「次は ○○ の段（`/product-design:init` で続ける）」と添える。`next` が `null` なら ① から ④ はすべて承認済み。`outputs` が `pending` なのは、出力がプラグインの次の段階で足すものだからで、不備ではない。
2. `ds_errors`（デザインシステムの中の不備）があれば、種類ごとにまとめて表にする。

   | 始まり | 意味 | 直し方 |
   | :- | :- | :- |
   | `tokens:` | `tokens.json` の形の誤り、必ずある役割の欠け、別名の参照先の欠けや循環 | 値を DTCG の形に直す、役割を足す、別名を直す |
   | `コントラスト` | 文字と背景の組が 4.5:1（大きい文字は 3:1）に届かない、組の役割が読めない | 色を濃くする（`swiftui.system` を付けた役割は、外して独自の値にする） |
   | `trace-missing` | 実在しない ID を指している | ID を直す |
   | `trace-none` | 根拠がない | 見出しの直後の行の `根拠:`、トークンの `from`、部品の `from` を書く |
   | `trace-layer` | 段を飛ばしている（トークンが `P` を指す、など） | `D` は `P` を、それより下は `D` を指す |
   | `… がありません` | 原則・基礎・パターン・文言の文書がない | 文書を戻す（ひな形は `/product-design:update` で `--add` できる） |
   | `components/…` | 部品の仕様の先頭のメタデータがない・読めない、`status` や `from` の形の誤り | メタデータを直す |
   | `docs/design-candidates/…` | 候補の `status` や `screens` の誤り | 候補のファイルを直す |
   | `design-system.json: stages.…` | 段の名前か状態の誤り | 設定を直す |
   | その他の ID の誤り（`… が 2 回出てきます`） | 同じ ID の見出しが 2 つある | 片方の ID を振り直す |

3. `deprecated`（廃止されたものを使っている）と `warnings`（`trace-orphan` の使われない原則、文字でない UI のコントラスト）があれば並べる。どちらも失敗ではない。
4. `candidates`（未決の候補）があれば、ファイルと画面を並べる。実装の前に決めるもの。
5. `stale`（古くなったもの）があれば並べる。`/product-design:update` で直る。

最後に、次にできることを伝える。

- デザインシステムの中の不備や、未決の候補は `/product-design:update` で直す・決める。
- `next` が ① から ④ のどれかなら、`/product-design:init` で続きから進める。
