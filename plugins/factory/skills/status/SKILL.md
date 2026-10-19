---
name: status
description: factory のラインと待ち行列、流した機能の進み具合（周回数、工程、直近の満足度、PR）を見せる。「factory はいまどうなってる？」「/factory:status」と言われたときに使う。
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/line/cli.js status) Bash(node ${CLAUDE_PLUGIN_ROOT}/line/cli.js feedback *) Bash(tail *)
---

# factory:status: ラインの状態

次を実行して、結果を表にして見せる。

```bash
node ${CLAUDE_PLUGIN_ROOT}/line/cli.js status
```

- **ライン**: 動いているか（`line.running`）
- **待ち行列**: `queue` の機能 ID を順番どおりに
- **機能**: `features` を、終わっていないもの（`running`・`paused`）を先にして並べる。列は ID・状態・周回数・工程・直近の満足度（% 表示）・かかった時間（`minutes` 分）・費用（`cost_usd`。Claude の分だけ）・人の評価（`feedback`）・PR
- **判定と人の評価の一致**: `agreement.rate`（マージされた機能のうち、人が good と言った割合）を、`agreement.good` / `agreement.rated` 件と一緒に出す。まだ評価がなければ「まだ評価がない」と書く

状態の言い方: `running` 実行中 / `paused` 利用上限で一時停止中 / `merged` マージ済み / `stopped` 止まった（Draft PR あり） / `error` 工場の側のエラーで止まった（アプリの不具合ではない。理由は state.json の `error`）

エラーや止まった理由を聞かれたら、`~/.factory/line.log` の最後の 50 行（`tail -n 50 ~/.factory/line.log`）と、その機能の `~/.factory/<project>/<id>/report.md` を読んで説明する。

## 人の評価を残す

マージされた機能のアプリを人が触ったあと、「良かった」「ダメだった」と言われたら、次を実行して評価を残す（メモは任意）。判定役が合格にしたものを人も良いと思ったかの一致率を、上の表で見せるのに使う。

```bash
node ${CLAUDE_PLUGIN_ROOT}/line/cli.js feedback . <id> good|bad <メモ>
```

評価がまだない、マージされた機能があれば、表のあとに「触ってみたら評価を教えてください」と一言添える。
