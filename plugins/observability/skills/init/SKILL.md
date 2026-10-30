---
name: init
description: アプリの観測の基盤（障害の確認・ログ・計測と分析・SLO・リリースの健全性・プライバシー・運用）を、観点ごとに AI と壁打ちして決め、使っている言語・フレームワークに合ったコード（ロガー・エラー監視・計測のラッパー・相関 ID・マスキング）と運用文書（決定の記録・ログの決まり・トラッキングプラン・アラートと runbook）と機械のチェックを置く。「ログ基盤を作って」「エラー監視と計測を入れたい」「障害を追えるようにしたい」「/observability:init」と言われたときに使う。途中で止めても続きから始められ、決めた観点をやり直すこともできる。
argument-hint: "[観点の id（scope / incident / logging / analytics / metrics / release / privacy / operations）…] [--no-code]"
model: opus
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *) Bash(node observability/check.mjs*) Bash(git fetch *) Bash(git status*) Bash(git rev-parse *) Bash(git diff*) Bash(git log *) Bash(git switch *) Bash(git add *) Bash(git commit *)
---

# observability:init: 観測の基盤を壁打ちで決めて作る

引数: $ARGUMENTS

0. 準備 → 1. リポジトリを調べる → 2. ひな形を置く → 3. 観点ごとの壁打ち → 4. 計画の承認 → 5. 作る → 6. 確かめる → 7. 人がやることを渡す → 8. コミット、の順に進める。設計は `${CLAUDE_PLUGIN_ROOT}/DESIGN.md`、観点の中身は `${CLAUDE_PLUGIN_ROOT}/references/perspectives.md`、スタックごとの定番は `${CLAUDE_PLUGIN_ROOT}/references/stacks/`。

引数に観点の id があれば、その観点だけをやり直す（3〜6 をその観点に絞る）。`--no-code` があれば、運用文書とチェッカーだけを置き、アプリのコードは変えない（5 のコードを「あとでやること」に書く）。

質問は必ず **AskUserQuestion** で出す。本文に質問を並べない。1 回に出すのは、答えが前の答えに依存しない質問だけ（最大 4 問）。選択肢をつけ、おすすめは先頭にして「(Recommended)」を付ける。**調べれば分かること（今のロガー、エラー処理、計測の呼び出し、デプロイ先）は質問せず、自分で調べる。**

**壁打ちとして進める**：選択肢を並べるだけにしない。質問の前に、調べて分かったことと、おすすめとその理由（このリポジトリの事実か、前に決めたことに結びつけて）を 2〜4 行で言う。答えが前の答えと矛盾する、費用や個人情報で後から困る、見る人がいない、といったときは、そう言ってから進める（決めるのは人）。姿勢の詳細は `perspectives.md` の「壁打ちの姿勢」。

## 0. 準備

- 対象のリポジトリは `git rev-parse --show-toplevel`。以降のコマンドはすべてそのパスで実行する。
- `observability/config.json` があれば `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs status <repo>` を見る。
  - `vendored_check` が `stale` なら、`install` を動かして check.mjs を新しくする。
  - 引数に観点がなければ、`progress.next` の観点から続ける。`next` が `null`（すべて決めた）なら、どの観点をやり直すかを AskUserQuestion で聞く（決めた観点の一覧から、複数選択）。
  - 再開するときは、1 を短くやり直し（コードが変わっているかもしれない）、`observability/README.md` の決定を読んでから続ける。2 は飛ばす。
- `git fetch -q origin` のあと `git status -sb` を見る。まだコミットしていない変更があれば、それを伝えて続けてよいか尋ねる。

## 1. リポジトリを調べる

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs detect <repo>
```

`stacks`（スタックと場所）、`tools`（もう入っている道具）、`delivery`（CI・ホスティングの手がかり）、`references`（読むべき `references/stacks/*.md`）が出る。`references` のファイルを読み、さらに次をコードで確かめて、10〜15 行のメモにする（ファイル:行つき。推測は推測と書く）。アプリが大きければ、Explore のサブエージェントに分けて調べさせてよい。

- 今のログ：ロガーがあるか、`console.log`・`print`・`NSLog`・`Log.d` などの直書きのおおよその数
- 今のエラー処理：グローバルなハンドラ、エラーバウンダリ、握りつぶしている `catch`
- 今の計測：SDK と呼び出しの場所、イベント名の揺れ
- クリティカルそうな流れ（認証・決済・投稿・同期など）と、サーバーとクライアントの境目（API の呼び出し）
- リリースとデプロイ：CI、ホスティング、バージョンの付け方、フィーチャーフラグ
- プライバシー：プライバシーポリシー、同意の UI、`PrivacyInfo.xcprivacy`
- ほかのプラグインの成果物：feature-docs（`docs/product/overview.md` の KPI、`tracking/*.yaml` のイベントの定義）、design-system

`detect` で判定できないスタック（`stacks` が空、または `other.md`）は、メモに書いて 3 の「目的と範囲」で確かめる。

## 2. ひな形を置く

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs install <repo>
```

`observability/`（`config.json`・`README.md`・`logging.md`・`events.yaml`・`alerts.yaml`・`runbooks/_triage.md`・`incidents/README.md`・`check.mjs`）ができる。**すでにあるファイルは上書きしない**（`skipped` に出る）。`config.json` の `stacks` に 1 のスタック（`{ "id", "dir" }`）を書く。

## 3. 観点ごとの壁打ち

`perspectives.md` の観点を順に（`scope` → `incident` → `logging` → `analytics` → `metrics` → `release` → `privacy` → `operations`）進める。1 つの観点ごとに：

1. その観点の「調べる」で分かったことと、スタックの定番（`references/stacks/` の表）から、おすすめを決める。会社で契約している道具・1 で見つけた道具があれば、それを優先する。
2. 「聞く」を AskUserQuestion で聞く。選択肢はこのリポジトリに合わせて作る（例：守りたい流れは、見つけた画面やエンドポイントの名前で）。
3. 「突っ込む」に当たることがあれば、言ってから確かめる。
4. 決まったことを 3〜6 行でまとめて見せ、AskUserQuestion で「これで決める (Recommended) / 直す / この観点は今は決めない」を聞く。
   - 決めたら：`observability/README.md` のその節と表（状態は「決定」、道具）と「決定の記録」（日付・観点・決めたこと・理由）を書き、`config.json` の `progress` にその id を、`tools` に道具（`errors`・`logging`・`analytics`・`metrics`・`tracing`・`alerting` などのキー）を足す。この時点で書くのは文書だけ。コードは 5 で作る。
   - 決めないなら：README の表を「あとで」にして、理由を書く。`progress` には足さない。
5. 次の観点に進む前に、ここまでの決定と矛盾しないかを見直す。

ユーザーが「もう十分」「あとはおまかせ」と言ったら、残りの観点はおすすめで決め、README の決定の記録に「おまかせで決めた。見直す条件：…」と書く。

## 4. 計画の承認

作るものを一覧にして見せる。

- **アプリのコード**：置くファイル（ロガー、エラー監視の初期化、グローバルなエラーハンドラ、計測のラッパー、相関 ID のミドルウェア・インターセプター、マスキング）と、変える既存のファイル
- **依存**：足すパッケージ。**名前とバージョンは、入れる前にレジストリか公式ドキュメントで最新を確かめる**（WebSearch か、`npm view <pkg> version` などのパッケージマネージャーのコマンド）
- **設定と秘密の値**：使う環境変数（`.env.example` に名前だけを書く）。値は人が設定する
- **CI**：シンボル・ソースマップのアップロード、`observability/check.mjs` を PR ごとに動かすか（GitHub Actions なら、5 で `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs install <repo> --ci` が `.github/workflows/observability.yml` を置く。ほかの CI なら、その設定に `node observability/check.mjs` を足す）
- **運用文書**：`logging.md`・`events.yaml`（最初のイベント）・`alerts.yaml`（SLO とアラート）・runbook
- **あとでやること**：今回は入れないもの

AskUserQuestion で「この計画で作る (Recommended) / 直す / 文書だけ置いてコードは作らない」を聞く。

## 5. 作る

- 既存の書き方（ディレクトリの分け方、命名、DI、テストの置き方）に合わせる。`references/stacks/` の「置くもの」は形の目安で、そのまま写さない。
- 依存は、そのリポジトリのパッケージマネージャーで入れる（`npx expo install`・`pnpm add`・SPM・Gradle の version catalog・`flutter pub add`・`uv add`・`bundle add` など）。
- **値はコード・設定ファイル・コミットに書かない**。環境変数から読み、`.env.example` に名前だけを足す。開発中と `__DEV__`・`kDebugMode`・テストのときは送らない。
- **クライアント（アプリ・ブラウザ）に入れた値は、ビルド設定や環境変数を通しても、誰でも取り出せる**（BuildConfig・`--dart-define`・xcconfig・`EXPO_PUBLIC_`・`NEXT_PUBLIC_` も同じ）。クライアントに入れてよいのは送信にしか使えない値（エラー監視の DSN、計測の書き込み用のキー、RUM の client token）だけ。アップロード用のトークン（`SENTRY_AUTH_TOKEN` など）、管理用・読み出し用の API キー、計測の secret は、CI とサーバーの secret にだけ置く。
- エラー監視の個人情報を送る設定（Sentry の `sendDefaultPii` / `send_default_pii`、リクエストの本文、Session Replay の入力）は false のままにする。セットアップのウィザードが true にしたら戻し、要るなら理由を README に書く。
- マスキングと計測のラッパーには、あれば `dev-flow:tdd` の進め方でテストを書く（伏せるべきキーが伏せられる、型にないイベントがコンパイルで落ちる、など）。
- 計測：`events.yaml` に、3 の「答えたい問い」に答えるイベントだけを書く（`question` に問いを書く）。コードで送り始めたものは `status: active`、まだのものは `planned`。
- feature-docs の `tracking/*.yaml` にイベントの定義（trigger・properties）があれば、`events.yaml` に移し（`owner` と `question` を足す）、`tracking` には `feature` と各イベントの `name`・`kpi` だけを残す。定義を 2 か所に置かない（4 の計画に入れて承認をもらう）。
- アラート：`alerts.yaml` に書き、アラートごとに `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs template runbook` から `observability/runbooks/<id>.md` を作る。道具の側のアラート（Sentry のアラートルール、Datadog の monitor など）を作るのは人。設定の手順を runbook と 7 の一覧に書く。Terraform などでアラートをコードにしているなら、そのコードも作る。
- チェッカー：`config.json` の `code` に、ラッパーの形に合った `event_calls`（1 つ目のグループがイベント名）と `forbidden`（直書きの禁止、SDK を直接呼ぶことの禁止。ロガーとラッパー自身は `allow`）を書く。例は `references/stacks/` の「チェッカーの設定例」。今の直書きが多くて一度に直せないなら、`level: "warning"` で始め、README の「あとでやること」に「error にする」を書く。
- `logging.md` の「形」と「例」を、このリポジトリのロガーで書き直す。

## 6. 確かめる

1. アプリのビルド・テスト・lint を動かす（あれば `dev-flow:test-runner` に任せる）。失敗したら直す。
2. `node observability/check.mjs` が通ることを確かめる。誤りは直す。警告は内容を伝える。
3. 入れた初期化が本当に動くかは、送る先がまだないと確かめられない。確かめ方（テストのエラーを送って、エラー監視に届くか見る、など）を 7 の一覧に書く。

## 7. 人がやることを渡す

アカウントやプロジェクトの作成、秘密の値の設定、道具の側のアラート・ダッシュボードの作成は、人にしかできない（このスキルではアカウントを作らず、値を入力しない）。次の形で一覧にして見せ、同じものを README の「あとでやること」にも書く。

```markdown
- [ ] Sentry でプロジェクトを作り、DSN を `EXPO_PUBLIC_SENTRY_DSN` に、ソースマップのアップロード用の `SENTRY_AUTH_TOKEN` を EAS の環境変数（secret）と CI の secret に設定する
- [ ] Sentry のアラートルール「新しい種類のエラー」を作り、通知先を #alerts-app にする（runbooks/app-new-error.md）
- [ ] 動作確認：開発ビルドで「テストのエラーを送る」を押し、Sentry に届くか見る
```

## 8. コミット

1. ルートの `CLAUDE.md` に、次を足してよいか尋ねる（ないなら作る）。エージェントが決まりを守れるようにするため。

   ```markdown
   ## ログと計測
   決まりは observability/README.md と observability/logging.md。ログはロガーを通し、計測はラッパーを通す。
   新しいイベントは observability/events.yaml に書いてから送る（/observability:event）。`node observability/check.mjs` が通ることを確かめる。
   ```

2. 変えたものの一覧を見せ、AskUserQuestion で「ブランチを作ってコミット (Recommended) / 今のブランチにコミット / コミットしない」を聞く。ブランチは `observability/init`（観点のやり直しなら `observability/<id>`）。
3. 最後に、次の一歩を伝える：「イベントを足すときは `/observability:event`、障害が起きたら `/observability:triage <症状かアラート>`、整合は `/observability:check`」。
