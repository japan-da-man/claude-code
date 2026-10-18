---
name: status
description: factory のラインと待ち行列、流した機能の進み具合（周回数、工程、直近の満足度、PR）を見せる。「factory はいまどうなってる？」「/factory:status」と言われたときに使う。
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/line/cli.js status) Bash(tail *)
---

# factory:status: ラインの状態

次を実行して、結果を表にして見せる。

```bash
node ${CLAUDE_PLUGIN_ROOT}/line/cli.js status
```

- **ライン**: 動いているか（`line.running`）
- **待ち行列**: `queue` の機能 ID を順番どおりに
- **機能**: `features` を、終わっていないもの（`running`・`paused`）を先にして並べる。列は ID・状態・周回数・工程・直近の満足度（% 表示）・PR

状態の言い方: `running` 実行中 / `paused` 利用上限で一時停止中 / `merged` マージ済み / `stopped` 止まった（Draft PR あり） / `error` 工場の側のエラーで止まった（アプリの不具合ではない。理由は state.json の `error`）

エラーや止まった理由を聞かれたら、`~/.factory/line.log` の最後の 50 行（`tail -n 50 ~/.factory/line.log`）と、その機能の `~/.factory/<project>/<id>/report.md` を読んで説明する。
