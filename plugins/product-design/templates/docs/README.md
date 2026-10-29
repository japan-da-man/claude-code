# デザインシステム

このアプリの見た目と振る舞いの決まり。人が `/product-design:init` と `/product-design:update` で決めたもので、画面を作る人と道具は、これに従う。**ここに書かれていない見た目を、その場で決めない。**

- 土台: <!-- Apple HIG / shadcn/ui ＋ Tailwind（design-system.json の base） -->
- 版: design-system.json の `ds_version`。変更は [CHANGELOG.md](CHANGELOG.md)

## 段と文書

上の段から下の段へ、根拠（ID）でつながっている。下の段の決まりは、どれも上の段のどれかを根拠に持つ。

| 段 | ファイル | 中身 |
| :- | :- | :- |
| ① プロダクトの原則 | [docs/product/principles.md](../docs/product/principles.md) | 誰のために何をするか（ID `P1`…） |
| ② デザインの原則 | [principles.md](principles.md) | 見た目と振る舞いの判断（ID `D1`…） |
| ③ 基礎とトークン | [foundations.md](foundations.md)、[tokens.json](tokens.json) | 色・文字・余白・角丸・影・動き・アイコン・アクセシビリティ。トークンは DTCG 2025.10 |
| ④ 部品 | [components/](components) | プラットフォームに依らない部品の仕様（1 部品 1 ファイル） |
| ④ パターン | [patterns.md](patterns.md) | 画面の型と使い分け |
| ④ 文言 | [copy.md](copy.md) | 言葉の決まり |
| 設定 | design-system.json | 使う側が最初に読む入口（守るファイル、チェックのコマンド） |
| チェック | check.mjs | 機械のチェック（プラグインから写したもの。手で直さない） |

## 原則の要約

<!-- /product-design:init で、② のデザインの原則を 1 行ずつ要約する -->

## トークンの使いどころ

- 使ってよいのは意味の段（`color.*`・`font.*`・`space.*`・`radius.*`・`shadow.*`・`duration.*`・`easing.*`）だけ。基本の段（`primitive.*`）と生の値は使わない。
- 文字と背景の組は、tokens.json の `contrast` の組を守る。

## 部品

部品の仕様は [components/](components) にある。標準の部品で足りるものも、必ず仕様の部品を通して使う。

## 足りないものが見つかったとき

1. 標準の別の手段で足りるか確かめる。
2. 足りなければ、**ある部品とトークンだけを組み合わせて** 仮の形を組み、作業は先に進める。直書きの値は使わない。
3. `docs/design-candidates/<短い名前>.md` に候補として書く（書き方は [docs/design-candidates/README.md](../docs/design-candidates/README.md)）。同じ候補がすでにあれば、`screens` に画面を書き足す。
4. 決まりにするかは、人が `/product-design:update` で決める。デザインシステムのファイル（`design-system/` と、アプリの中のデザインシステムのコード）は、機能を作るときには変えない。

## Claude Design で案を作るとき

この部品とトークンだけで案を組む。足りないものは、ある部品とトークンで仮の形を組み、案の下に「部品の候補」として、どの画面で何のために何が足りないかを書く。

## チェック

```bash
node design-system/check.mjs
```

デザインシステムの中の不備（トークン、根拠のつながり）と未決の候補を出す。`--strict` を付けると、デザインシステムの中の不備でも終了コード 1 になる。
