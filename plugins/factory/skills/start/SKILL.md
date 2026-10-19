---
name: start
description: factory で機能を 1 つ作り始める。一問一答のインタビューで仕様を固め、隠しシナリオを作って承認をもらい、裏のラインに流す。あとは実装・検証・判定・マージまで自動で進む。「factory で〇〇を作って」「/factory:start <要望>」と言われたときに使う。バグ修正や小さな改善にも使える。
argument-hint: "<作りたい機能や直したいこと>"
model: opus
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/line/cli.js *) Bash(git fetch *) Bash(git status *) Bash(git rev-parse *) Bash(mkdir -p *) Bash(cp *)
---

# factory:start: 要望から裏のラインへ

要望: $ARGUMENTS

1. 仕様インタビュー → 2. 仕様を書く → 2.5 UI 案を選ぶ（画面が変わる機能だけ）→ 3. シナリオを作る → 4. シナリオの承認 → 5. ラインに流す、の順に進める。**このスキルではアプリのコードを変えない。**

## 0. 準備

- このリポジトリに `.factory/config.json` がなければ、先に `/factory:init` を実行するよう伝えて終える。
- 要望が空なら、何を作りたいか尋ねる。
- `git fetch -q origin` のあと `git status -sb` を見る。手元のブランチが origin より遅れていたら、AskUserQuestion で pull してよいか尋ね、よければ `git pull --ff-only` する。ラインは origin の最新から作業を始めるので、手元が古いままだと、インタビューとシナリオ作成が古いコードを前提にしてしまう。

## 1. 仕様インタビュー

AskUserQuestion で一問一答をして、仕様を固める。

`design-system/design-system.json` があれば、始める前に、その `docs` のうち文言の決まり（`copy.md`）と画面の型（`patterns.md`）を読む。画面やメッセージについての質問は、その決まりと型の範囲で選択肢を作る（決まりにない見た目を勝手に提案しない。必要なら「デザインシステムに足す」こととして別に挙げる）。

- 1 回に出すのは、**答えが前の答えに依存しない質問だけ**（最大 4 問）。選択肢をつけ、おすすめは先頭にして「(Recommended)」を付ける。
- **調べれば分かること**（今ある画面、データの持ち方、使っている仕組み）は質問せず、自分でリポジトリを読んで調べる。
- 次の **観点リスト** がすべて埋まるまで続ける。ユーザーが「もう十分」と言ったら、そこで打ち切る。
  1. 目的（なぜ必要か）と対象ユーザー
  2. 正常系（主な操作の流れ）
  3. 異常系・エッジケース（空、上限、通信なし、権限なし、途中で中断）
  4. やらないこと
  5. 既存機能への影響
  6. 画面と操作（どこに何が出るか）
  7. データ（何を保存するか、移行は必要か）

## 2. 仕様を書く

機能の短い英語名（例 `share-memo`）を決め、置き場所を作る:

```bash
node ${CLAUDE_PLUGIN_ROOT}/line/cli.js new "$(git rev-parse --show-toplevel)" <英語名>
```

出力の `spec` のパスに仕様を書く。見出しは観点リストの 7 つにし、末尾に「インタビューの要約」として問答を短く残す。ユーザーの言葉（ふつうは日本語）で書く。

仕様は、ラインがブランチの最初のコミットとして `docs/factory/<id>/spec.md` に入れる。手元のチェックアウトには書かない。

書けたら、仕様の要点を短く見せて、AskUserQuestion で「この仕様で進める / 直す」を確かめる。

## 2.5 UI 案を選ぶ（画面が変わる機能だけ）

次の両方を満たすときに行う。満たさなければ飛ばす（飛ばした理由を一言伝える）。

- `design-system/design-system.json` がある（案はデザインシステムの部品で作るため）
- 仕様の「画面と操作」で、新しい表示や操作が増える・変わる（文言だけの変更やロジックだけの修正なら飛ばす）

手順:

1. 撮影用の、捨てる worktree を作る。

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/line/cli.js mock-prepare "$(git rev-parse --show-toplevel)" <id>
   ```

2. サブエージェント `factory:ui-mocker` に、仕様のパス、出力の `dir`・`mocks`・`catalog`、作る案の数（ふつうは 2、迷う機能なら 3）を渡して、案を作らせる。
3. 案のページを撮る（ビルドがあるので数分かかる。Bash のタイムアウトは 10 分にする）。撮影はアプリの `design-system/shoot.mjs` が行い、画像は `<出力の out>/factory-mock-<x>-light.png` になる。`shoot.mjs` がないと言われたら、`/design-system:update` でデザインシステムを新しい版にするよう伝える。ラインが動いているあいだはシミュレーターを使えないので、断られたら、待つか飛ばすかを AskUserQuestion で尋ねる。

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/line/cli.js mock-shoot "$(git rev-parse --show-toplevel)" <id> factory-mock-a factory-mock-b
   ```

4. 撮れた画像を Read で見て、案ごとに「どこが違うか」を短く添えて、ユーザーに画像を見せる（SendUserFile が使えれば、それで画像を送る）。AskUserQuestion で選んでもらう（選択肢は案ごと。おすすめを先頭に。「どれも違う」なら直したい点を聞き、作成役にもう一度作らせる）。
5. 選ばれた案の画像を、仕様と同じフォルダの `ui/chosen.png` に写す（`mkdir -p <機能のフォルダ>/ui && cp <出力の out>/factory-mock-<x>-light.png <機能のフォルダ>/ui/chosen.png`）。ほかの案の画像はブランチに入れない（`ui-options/` に残るだけ）。
6. 仕様の「6. 画面と操作」を、選ばれた案に合わせて書き直す。どこに・どの部品で・どんな文言が出るかを具体的に書き、「選んだ UI 案: `ui/chosen.png`」と添える。作成役が「部品の候補」を挙げていたら、それも書く。
7. 撮影用の worktree を消す。

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/line/cli.js mock-clean "$(git rev-parse --show-toplevel)" <id>
   ```

## 3. シナリオを作る

`.factory/config.json` の `models.scenario` を見て、作成役を選ぶ（書かれていなければ Claude）。

- **`codex` か `codex:<モデル>` のとき**：Codex に書かせる。実装役（Claude）とは別の会社のモデルにして、死角を重ねないためのもの。数分かかるので、Bash のタイムアウトを長め（10 分）にする。

  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/line/cli.js scenarios "$(git rev-parse --show-toplevel)" <id> <models.scenario の値>
  ```

  Codex は機能のフォルダの中でだけ書き込める（`workspace-write`）。出力の最後が、シナリオの一覧と仕様の曖昧な点。
- **それ以外のとき**：サブエージェント `factory:scenario-writer` に、次を渡して任せる。
  - 仕様のパス（出力の `spec`）
  - シナリオを書き出すフォルダ（出力の `scenarios`）
  - リポジトリのパス

どちらの場合も、書かれたシナリオのファイルを読んで、次の承認に使う。

**シナリオの中身を、このあと実装に関わるところへ書き写さない**（リポジトリ、コミット、PR には書かない）。

## 4. シナリオの承認

1. シナリオの一覧を `id`・`title`・`required` の表で見せる。シナリオ作成役が仕様の曖昧な点を挙げていたら、それも見せる。
2. 自分でもシナリオを読み、問題がないか見る。特に、**画面の操作だけでは前提を作れないもの**（古い版で保存したデータ、外部サービスの状態など）は、検証役が操作できず必ず不合格になるので、外すよう提案する。必須（`required: true`）は、機能の中心になる数本に絞って提案する（作成役は多めに必須にしがち）。
3. AskUserQuestion は 1 回に 4 問まで、1 問に選択肢 4 つまでなので、シナリオを **4 本ずつの組** に分けて聞く（1 回で 16 本まで。それより多ければ回を分ける）。
   - **1 回目「必須にするシナリオ」**：組ごとに 1 問（multiSelect）。選択肢のラベルは `id` と短い題名、説明に何を確かめるか。必須をおすすめするものはラベルの末尾に「(Recommended)」を付ける。
   - **2 回目「外す・直すシナリオ」**：同じ組で、組ごとに 1 問（multiSelect）。外すことをおすすめするもの（前提を作れないものなど）は「(Recommended)」を付け、説明に理由を書く。選ばれたものは、続けて 1 本ずつ「外す / 直す」と直し方を聞く。
   - 組の問いのヘッダーは「必須 1/3」のように、何組目か分かるようにする。
   外すシナリオは消さずに、機能のフォルダの `scenarios-removed/` に移す。各ファイルの `required` を答えに合わせる。
4. 最後に「このシナリオで承認する」を AskUserQuestion で確かめる。

## 5. ラインに流す

承認されたら、待ち行列に入れる:

```bash
node ${CLAUDE_PLUGIN_ROOT}/line/cli.js submit "$(git rev-parse --show-toplevel)" <id>
```

ラインが止まっていれば、裏で起動する（`started: true`）。動いていれば、順番待ちになる。

ユーザーには次を伝えて終える。

- 機能 ID と、ラインが起動したか・順番待ちか
- 結果は Mac の通知と PR のレポートで知らせること
- 進み具合は `/factory:status` で見られること
