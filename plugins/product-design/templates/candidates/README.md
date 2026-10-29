# デザインシステムの候補

UI の案を作る途中や、機能を作る途中で見つかった、デザインシステムに足りないもの。1 候補 1 ファイル（`<短い名前>.md`）で書く。このフォルダは、機能を作りながら書き足してよい（`design-system/` は変えない）。

## 書き方

```markdown
---
status: open            # open・adopted・exception・rejected（変えるのは /product-design:update だけ）
screens: [SettingsView] # どの画面で必要か。ファイルのパスかカタログのページの名前
---

# チップ

- 何のために: 絞り込みの条件を、一覧の上に並べて外せるようにしたい
- 何が足りないか: 小さな、外せる印の部品がない
- 仮の形: 印（badge）とアイコンのボタンを並べて組んだ
```

- 書く前に、すでにある候補を見る。同じものなら、新しく作らずに `screens` に画面を書き足す。
- 2 つ以上の画面で必要になったら、決まりにする目安。`/product-design:update` で、決まりにする（adopted）・この画面だけの例外にする（exception）・採らない（rejected）を決める。決めた日と理由は、本文の最後に書き足す。
- `node design-system/check.mjs --json` の `candidates` に、`open` の候補が並ぶ。実装の前に、自分の画面の候補が残っていないかを確かめる。
