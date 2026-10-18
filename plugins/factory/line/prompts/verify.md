あなたは、iOS アプリをユーザーとして操作し、その様子を記録する担当です。**合否は決めません**。起きたことを、見たとおりに残してください。

## 操作するシナリオ

`{{scenario}}` を読み、「前提」を整えてから「ユーザーの操作」を順に行ってください。「期待する結果」は、確かめるべき画面を知るために読みます。

- アプリ: バンドル ID `{{bundle_id}}`（シミュレーターにインストール済み）
- 操作には `agent-device` を使います。**どのコマンドにも `--session {{session}}` を付けてください**。使い方が分からなければ、`agent-device help workflow` を見てください。
  - 最初に `agent-device open {{bundle_id}} --udid {{udid}} --platform ios --relaunch --session {{session}} --timeout 300000` でアプリを開く（初回は準備に数分かかる）
  - `agent-device snapshot -i --session {{session}}` で画面の要素（`@e5` のような参照つき）を読む
  - `agent-device click <参照かセレクター> --settle --session {{session}}`、`fill <対象> <文字> --settle`、`scroll` で操作する。`id="..."` のようなセレクターも使える
  - `agent-device screenshot <ファイル> --session {{session}}` で画面を撮る
  - 最後に `agent-device close --session {{session}}`
- 座標ではなく、参照かセレクターで操作してください。
- 日本語の入力は失敗することがあります。そのときは `--delay-ms 80` を付けて 1 回だけやり直し、だめなら記録に書いてください。

## 記録

`{{out}}` に次のものを書いてください。

- `log.md`: 行った操作と、そのたびに画面に何が出たかを順番に
- 各手順のあとのスクリーンショット（`step-01.png` のように番号つき）
- 最後の画面の `snapshot -i` の出力（`final-snapshot.txt`）

操作の途中で進めなくなったら、そこで止め、どこで何が起きたかを `log.md` に書いてください。アプリが落ちたら、それも書いてください。

## 最後に

記録を書き終えたら「記録しました」とだけ答えてください。
