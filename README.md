# claude-code

japan-da-man の Claude Code プラグイン（mods を含む）を管理するマーケットプレイス。

## プラグイン

| 名前 | 内容 |
| :- | :- |
| [japan-da-man-mods](plugins/japan-da-man-mods) | **まとめてインストール用**。下のプラグインを全部入れる |
| [todo-mod](plugins/todo-mod) | `/todo` で TODO パネルを開く。チェックを入れたタスクを Claude に依頼する |
| [token-weather](plugins/token-weather) | コンテキストの埋まり具合を天気でプロンプトの上に表示する（☀ Clear → ☁ Cloudy → ☂ Showers → ☇ Storm → ↯ Compact soon）。直近12ターンのグラフと、直前のターンの増減（`▲ +98.3k last turn`）付き。`/weather` で表示切り替え |
| [usage-stats](plugins/usage-stats) | `/stats` で利用統計のパネルを開く。セッション数・メッセージ数・トークン数・利用日数・連続日数・よく使うモデル・日ごとのヒートマップ |
| [blast-radius](plugins/blast-radius) | 危険なシェルコマンドを実行前に止め、何が消えるか・変わるかをペインに出して **Proceed / Cancel** で選ばせる（10分答えがなければ止める）。ターミナルのないデスクトップアプリなどでは、ペインの代わりに確認ダイアログ（AskUserQuestion）で聞き、聞けないときは待たずに止めて、Terminal で自分で実行するためのコマンドを Claude に渡す。`rm -r`/`-f`、`git reset --hard`、force push、`git clean`、変更の破棄、`git branch -D`（コミットがすべて HEAD にある、rebase マージ済みのブランチは止めない）、`git stash drop/clear`、マイグレーション、`find -delete`、`xargs rm`。`bash -c` / `eval` の中も調べる。`/blast-radius` で履歴 |
| [replay-theater](plugins/replay-theater) | ターンの中で Claude が行ったファイル編集を記録する。ターンが終わるとプロンプトの上に `▶ Replay: N edits` が出て、`r` か `/replay` でペインを開き、編集を 1 件ずつ差分で見られる（Prev / Next / Close） |
| [spec-flow](plugins/spec-flow) | 「〇〇な機能が欲しい」と話しかけるか `/spec-flow:spec <要望>` で、**要求整理 → 影響画面確認 → 要件定義 → 機能案・UI案** を 1 段階ずつ承認しながら進める。曖昧な点はヒアリングし、影響調査と案出しはサブエージェントが行う。成果物は `docs/specs/<id>/`（UI 案の HTML モックは Desktop なら Artifact にも公開。`--local` で公開しない）。`/specs` でチェックリストを開き、チェックで承認・修正依頼もできる |
| [dev-flow](plugins/dev-flow) | 汎用の開発フロー。skills `plan`（小さなタスクに分けて承認をもらってから着手）・`tdd`（RED → GREEN → REFACTOR）・`debug`（再現 → 仮説 → 検証で原因を確かめてから直す）・`review`（重要度つきの差分レビュー）。サブエージェント `code-explorer`（横断調査）・`test-runner`（テスト結果の要約）・`reviewer`（別コンテキストでレビュー、修正はしない）が長い出力をメインに持ち込まない |
| [dev-extras](plugins/dev-extras) | 他の OSS から選んで取り込んだ skill（すべて MIT、出典は各 README と `licenses/`）。`ponytail`（最小の実装に絞る）・`ponytail-review`（作り込みすぎだけを探す）・`grill-me`（質問攻めで計画を詰める）・`handoff`（バックグラウンドエージェントに引き継ぐ）・`verification-before-completion`（検証してから完了と言う）・`security-audit`（Cloudflare 製のセキュリティ監査） |
| [factory](plugins/factory) | AI のソフトウェアファクトリー（いまは iOS アプリ向け）。`/factory:init` で設定を作り、`/factory:start <要望>` で一問一答のインタビュー → 仕様 → 隠しシナリオの承認まで行うと、裏のラインが **実装（Sonnet, TDD）→ ビルドと全テスト → シミュレーターでの検証（agent-device）→ 判定（Opus）** を回し、満足度が基準を超えたら PR を squash マージする。実装役からシナリオは見えない（deny とサンドボックス）。判定役とシナリオ作成役は、設定で Codex（`codex exec`）にもできる。実装の前に今のアプリでシナリオを流す陰性対照、検証したコミット（SHA）だけをマージする縛り、シナリオの XCUITest による速い検証、症状を返さない最終関門のシナリオ、テストの有無・変更行数・lint の品質関門、時間と費用の記録も持つ。`/factory:status` で進み具合と、人の評価と判定の一致率。設計は [DESIGN.md](plugins/factory/DESIGN.md) |
| [design-system](plugins/design-system) | アプリの見た目の決まり（デザインシステム）を、人が決めて先に作り、育てる（いまは iOS / SwiftUI）。`/design-system:init` で今のコードから色・文字・余白・部品・文言・画面の形を読み取り、決まっていない点を一問一答で決めて、`design-system/` の文書と `tokens.json`、SwiftUI の部品（ボタン・入力・一覧・メッセージ・状態など 18 種類）とカタログ画面を置き、今の画面も書き換える。カタログはシミュレーターでライトとダークのスクリーンショットを撮って確かめる。`node design-system/check.mjs` が直書きの色・文字・余白や部品を通さないボタンをファイル:行つきで落とす（factory のゲートにも使える）。`/design-system:update` で変え、`/design-system:check` で調べる。Artifact の Design System に一方向で写す。設計は [DESIGN.md](plugins/design-system/DESIGN.md) |
| [feature-master](plugins/feature-master) | 機能マスタ（機能ごとの設計意図）をリポジトリで管理する。`/feature-master:init` で今のコードとドキュメントから機能をユースケース単位で洗い出し、区切り方・Actor・全体の前提（`product.md`）を確かめてから、全機能の機能名・概要・Actor・利用シーン（「状況 → したいこと」）・関連機能・大事にしていること・前提・想定していないことを `docs/features/<id>.md` に 1 機能 1 ファイルで下書きし（`draft: true`）、選んだ機能だけ一問一答で確かめる。CLAUDE.md か AGENTS.md に「機能を付け足すときや新機能を考えるときに先に読む」案内を足す。`/feature-master:check` が参照切れ・項目の漏れ・全体の前提の繰り返し・古い一覧をファイル:行つきで出し、古い一覧は確かめてから作り直す。設計は [DESIGN.md](plugins/feature-master/DESIGN.md) |
| [mod-dev](plugins/mod-dev) | skill `add-mod`。「〇〇する mod を作って」で雛形・テスト・登録まで行う。marketplace リポジトリでは marketplace.json / bundle / README も更新し、それ以外では単体の mod を作る |

## インストール

```bash
claude plugin marketplace add japan-da-man/claude-code
claude plugin install japan-da-man-mods@japan-da-man
```

1つずつ入れる場合は `claude plugin install <名前>@japan-da-man`。

更新:

```bash
claude plugin marketplace update japan-da-man
claude plugin update <名前>@japan-da-man
```

bundle に増えたプラグインを入れるときは、**update → install の順**で実行する（update だけだと増えた分は入らず、bundle が `failed to load` になる）:

```bash
claude plugin marketplace update japan-da-man
claude plugin update japan-da-man-mods@japan-da-man
claude plugin install japan-da-man-mods@japan-da-man
```

セッション内なら update のあと `/reload-plugins` でもよい。

## 開発

インストールせずに作業中のディレクトリを読み込む（保存するとホットリロードされる）:

```bash
claude --plugin-dir ./plugins/todo-mod
```

チェック:

```bash
claude plugin validate .
claude plugin validate ./plugins/todo-mod
```

テスト（`tests/*.test.ts` があるプラグイン）:

```bash
cd plugins/<name> && claude plugin test
```

## プラグインの追加

mod-dev を入れた状態でこのリポジトリを開き「〇〇する mod を追加して」と頼むと、skill [`add-mod`](plugins/mod-dev/skills/add-mod/SKILL.md) が下の手順（雛形・テスト・marketplace / bundle / README 更新・validate）をまとめてやる。手でやる場合:

1. `plugins/<name>/` に `.claude-plugin/plugin.json` と中身を置く
2. `.claude-plugin/marketplace.json` の `plugins` にエントリを追加する（`name` は `plugin.json` と同じにする）
3. まとめて入るようにするなら `plugins/japan-da-man-mods/.claude-plugin/plugin.json` の `dependencies` にも名前を足す

`plugin.json` に `version` を書いていないので、コミットごとに新しいバージョンとして扱われる。

mods は Claude Code v2.1.287 以降が必要。

## 公式 mod をもとにしたもの

`token-weather`・`blast-radius`・`replay-theater` は、Anthropic の [claude-code-playground](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods) にある同名の mod（Apache-2.0）をもとに手を加えたもの。各プラグインに `LICENSE` を同梱し、各 `hooks/register.js` の先頭に元のコードの著作権表示と、こちらで変えた点を書いている。
