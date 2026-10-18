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
- **Bash 1 回につき、`agent-device` のコマンドを 1 つだけ** 実行してください。`&&`・`;`・パイプ・ループ・`cd` は使えません（許可されておらず、拒否されます）。
- 座標ではなく、参照かセレクターで操作してください。
- 日本語の入力は失敗することがあります。そのときは `--delay-ms 80` を付けて 1 回だけやり直し、だめなら記録に書いてください。

## 記録

`{{out}}` に次のものを書いてください。

- `log.md`: 行った操作と、そのたびに画面に何が出たかを順番に
- 各手順のあとのスクリーンショット（`step-01.png` のように番号つき）
- 最後の画面の `snapshot -i` の出力（`final-snapshot.txt`）

- `result.json`: 次の形で、最後まで操作できたかどうか

```json
{"completed": true, "blocked_by_tool": false, "reason": ""}
```

- `completed`: シナリオの操作を最後まで行えたら `true`
- `blocked_by_tool`: **アプリではなく道具の都合で** 操作できなかったら `true`。たとえば、端末が使用中（`DEVICE_IN_USE`）、コマンドが許可されなかった、agent-device が起動しない、など。`reason` にエラーをそのまま書く
- アプリが落ちた、ボタンがない、表示が違う、のように **アプリの側の問題** で進めなくなったときは、`blocked_by_tool` は `false` にして、`completed` を `false` にする

操作の途中で進めなくなったら、そこで止め、どこで何が起きたかを `log.md` に書いてください。

## 最後に

記録と `result.json` を書き終えたら「記録しました」とだけ答えてください。
