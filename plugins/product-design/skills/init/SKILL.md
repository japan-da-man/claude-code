---
name: init
description: アプリのデザインシステムを、プロダクトの原則から一気通貫で最初に作る。① プロダクトの原則 → ② デザインの原則 → ③ 基礎とトークン（DTCG）→ ④ 部品の仕様・画面の型・文言 を、段ごとに一問一答で決めて承認をもらい、どの決まりにも上の段の ID を根拠として書き、機械のチェックを置く。途中で止めても続きから始められる。「デザインシステムを作って」「プロダクトの原則から作って」「/product-design:init」と言われたときに使う。アプリごとに 1 回。
argument-hint: "[--base hig|shadcn]"
model: opus
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *) Bash(node *design-system/check.mjs*) Bash(git fetch *) Bash(git status*) Bash(git rev-parse *) Bash(git diff*) Bash(git add *) Bash(git commit *)
---

# product-design:init: デザインシステムを作る

引数: $ARGUMENTS

プロダクトの原則から部品の仕様までを、**人が決めて**、根拠をたどれる形で作る。画面を作る人と道具は、これに従うだけになる。設計は `${CLAUDE_PLUGIN_ROOT}/DESIGN.md`。

0. 準備 → 1. アプリを調べる → 2. 土台を選んでひな形を置く → 3. ① プロダクトの原則 → 4. ② デザインの原則 → 5. ③ 基礎とトークン → 6. ④ 部品・パターン・文言 → 7. 確かめる → 8. コミット、の順に進める。段ごとに承認をもらい、承認したら次の段へ進む。

質問は必ず **AskUserQuestion** で出す。本文に質問を並べない。1 回に出すのは、答えが前の答えに依存しない質問だけ（最大 4 問）。選択肢をつけ、おすすめは先頭にして「(Recommended)」を付ける。**調べれば分かること（今の値、画面の作り、プロジェクトの設定）は質問せず、自分で調べる。**

> この版でできるのは ④ まで（プラットフォームに依らない部分）。⑤ の出力（HTML・SwiftUI・Expo の部品とカタログ、スクリーンショット、Claude の Design System への写し）は、プラグインの次の段階で足す。
>
> **始める前に選んでもらう**: SwiftUI の部品とカタログが今すぐ要るアプリは、product-design を始めずに `/design-system:init` を使う。一度 product-design で始めると（`design-system.json` が v2 になると）、`/design-system:*` はそのアプリを断るので、出力はこのプラグインの次の段階を待つことになる。0 で `design-system.json` がなく、1 で SwiftUI のアプリだとわかったら、2 の前に AskUserQuestion でどちらにするかを確かめる。

## 0. 準備

- 対象のアプリのリポジトリを決める。`git rev-parse --show-toplevel` がアプリのリポジトリでなければ、AskUserQuestion でパスを尋ね、以降のコマンドはすべてそのパスで実行する（`cd <repo> && …`）。
- `design-system/design-system.json` があれば、`node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs status <repo>` で段の進み具合（`stages`・`next`）を見る。
  - `status` がエラーになったら、その文を読む。`version` が 2 でない（v1）なら、v1 からの移行はまだこの版にないことを伝え、今は `/design-system:update` を使うよう勧めて終える。`tokens.json` が読めないなら、JSON の誤りを直してからやり直す。
  - `next` が `null`（① から ④ がすべて `approved`）なら、作り直さずに `/product-design:update` を勧めて終える。
  - 途中まで進んでいれば、1 を短くやり直して（今のコードと文書を読み直す）から、`next` の段から続ける。2 は飛ばす（置いたひな形と、書いた文書はそのまま使う）。
- `git fetch -q origin` のあと `git status -sb` を見る。origin より遅れていたら pull してよいか尋ねる。まだコミットしていない変更があれば、それを伝えて続けてよいか尋ねる。

## 1. アプリを調べる

次を調べて、短い表にまとめる（ファイル:行つき。推測で埋めない）。アプリが大きければ、Explore のサブエージェントに分けて調べさせてよい。

- **出すプラットフォーム**: リポジトリの直下と、その 1 つ下（`apps/*`・`packages/*` など）を見る。先に Expo を見る（prebuild した Expo のアプリには `ios/*.xcodeproj` もあるため）。
  - `package.json` に `expo` → Expo（iOS・Android・Web のどれに出すかは `app.json` と `package.json` の scripts を見る）
  - `*.xcodeproj`・`project.yml`・`Project.swift`（Tuist）・アプリを作る `Package.swift` → SwiftUI（iOS だけ）
  - `react-native` はあるが `expo` がない、SwiftUI と Expo の両方がある、どちらもない → 2 で聞く
- **今の見た目**: コードから、色・文字・余白と角丸・部品（ボタン、入力欄、一覧の行、メッセージ、空の状態、確認）・文言（エラー、空の状態、ボタン、確認の言い方）・画面の型（一覧・編集・詳細・設定）を読み取る。同じ役割に違う値を使っている「揺れ」も拾う。
- **今の文書**: README、`docs/` の中のプロダクトの説明や原則。`docs/product/principles.md` がすでにあるか。

## 2. 土台を選んでひな形を置く

1. 土台を決める（`DESIGN.md` 4節）。引数に `--base` があればそれを使う。なければ 1 の結果からおすすめを決め、AskUserQuestion で確かめる。
   - iOS だけ（SwiftUI）→ `hig`（Apple HIG）
   - iOS と Android（Expo）や Web に出す → `shadcn`（shadcn/ui ＋ Tailwind）
   - Expo で iOS だけに出す → どちらにするか聞く（おすすめは `shadcn`。Expo の部品は React Native Reusables を土台にするので、名前が揃う）
2. ひな形を置く:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs install <repo> --base <hig|shadcn>
   ```

   `design-system/design-system.json`（v2。段はすべて `pending`）、`docs/product/principles.md`、`design-system/` の文書・`tokens.json`・`components/`（18 部品）・`check.mjs`、`docs/design-candidates/README.md` ができる。**すでにあるファイルは上書きしない**（`skipped` に出る）。`docs/product/principles.md` が `skipped` なら、もとからあった文書なので、3 で読むだけにする。

## 3. ① プロダクトの原則

`docs/product/principles.md` は、デザインシステムの外の文書（仕様づくりや優先順位の判断にも使う）。

- **もとからあった**なら、読んで要約を見せる。原則の見出しに `### P1 …` の ID がなければ、付けてよいか尋ねる。断られたら、`docs/product/principles.md` は変えずに、ID つきの写しを作るかを尋ねる。作るなら:
  1. 写しを `docs/product/principles.ids.md` に置く（もとの原則を `### P1 …` の見出しに並べ直したもの。冒頭に「`docs/product/principles.md` の写し。もとを変えたら、ここも直す」と書く）。
  2. `design-system/design-system.json` の `product_principles` を写しに向け、`protected_paths` の `docs/product/principles.md` も写しの道のりに替える。
  3. `design-system/README.md` の ① のリンクを写しに向ける。
  4. もとの文書が変わっても写しは変わらないので、変えたら `/product-design:update` で写しも直すことを、ユーザーに伝える。
- **ひな形を置いた**なら、一問一答で書き直す。聞くこと:
  1. 誰のためのプロダクトか、その人が何に困っているか
  2. 優先順位を「A より B」の形で 3〜5 個（1 で読んだ README や今の画面から下書きを作り、選択肢にする）
- 原則は「A より B」の形にし、本文に、その原則で何を選ぶかを書く。**どちらを選ぶかで答えが変わらない原則**（「使いやすく」など）は、書き直してもらう。
- ID は `P1` から振る。ひな形の `<!-- … -->` のコメントは消す。

書けたら全文を見せ、AskUserQuestion で承認をもらう。承認されたら:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs stage <repo> product approved
```

## 4. ② デザインの原則

`design-system/principles.md` を、① から下書きして一問一答で決める。

- 見た目と振る舞いで迷ったときの判断を 3〜5 個。見出しは `### D1 …`、**見出しの直後の行に `根拠: P1, P2`**（どのプロダクトの原則から来たか）、本文に「だから、こうする」を具体的に書く。
- ① のどの原則にもつながらない原則は作らない。逆に、① の原則のどれも ② に降りてこないなら、それでよいか確かめる（check は `trace-orphan` の警告を出す）。
- 1 で見つけた「揺れ」を、どの原則で決めるかの例にする。

全文を見せて承認をもらい、`stage <repo> design approved`。

**承認したら、ひな形の根拠を付け直す。** ひな形の基礎・パターン・文言の `根拠:`、トークンの `from`、部品の `from` は、ひな形の D1〜D3（「読めることを優先」「土台の標準に合わせる」「1 画面の目的は 1 つ」）を指している。番号が同じでも中身が変わっていれば、意味がずれたまま check を通ってしまう。新しい ② の原則の中身を見て、5 と 6 で各節・各トークンのグループ・各部品の根拠を付け直す（5 と 6 の一問一答のついでに直す。番号の対応表を先に作っておくとよい）。

## 5. ③ 基礎とトークン

`design-system/foundations.md` と `design-system/tokens.json` を、1 で読み取った今の値と土台のひな形から下書きし、一問一答で決める。聞くこと:

1. ブランドの色（主な色）と、ダークモードに対応するか（色はライトとダークの両方を決める）
2. 状態の色（エラー・注意・成功・お知らせ）と、背景・面・文字・枠の色
3. 文字（システムの文字か、ほかの書体か。見出し・本文・補足の大きさと太さ）
4. 余白の刻みと角丸、影と動き
5. アイコンと、アクセシビリティの最低線（押せる大きさ、動きを減らす設定）

書き方（`DESIGN.md` 8節）:

- **トークンは DTCG 2025.10**。基本の段は最上位の `primitive` の下、意味の段（役割）は `color`・`font`・`space`・`radius`・`shadow`・`duration`・`easing` の下。色は `{ "colorSpace": "srgb", "components": [r, g, b], "hex": "#rrggbb" }`。ダークの値は `$extensions` の `com.github.japan-da-man.product-design` の `modes.dark` に書く。
- **必ずある役割は消さない**（ひな形のものと、`check.mjs` の `REQUIRED`）。役割を足してよい（名前は小文字の kebab-case）。`$description` に、その色や文字をどこに使うかを、ユーザーの言葉で書く。
- **根拠**: 意味の段のトークンには `$extensions` の `from` に `D` の ID を書く（グループに書けば中のトークンが受け継ぐ）。`foundations.md` は `##` の節ごとに、見出しの直後の行に `根拠: D…`。
- **コントラスト**: 文字に使う色と背景の組は、`tokens.json` の最上位の `$extensions` の `contrast` に `{ "fg": "…", "bg": "…" }` で書く。半透明の背景には `over` を、大きい文字だけに使う組には `"kind": "large-text"` を、枠などには `"kind": "ui"` を付ける。色を聞くときは、選択肢の説明に HEX と、主な背景の上でのコントラスト比を書く。文字に使う色は 4.5:1 以上をおすすめにする。
- **HIG のとき**: `swiftui.system` を付けた役割は、HIG の値の写しでなければならない（濃くできない）。ブランドの色は `tint`（`accentColor`。値は自由）に入れる。文字の色を独自の値にするなら、`swiftui.system` を外す。
- 文字のトークンは `$extensions` の `textStyle`（Dynamic Type の段の名前）を消さない。

直したら確かめる:

```bash
node <repo>/design-system/check.mjs --strict
```

`tokens:` で始まる誤りとコントラストの誤りがなくなるまで直す。全体を表（役割・ライト・ダーク・使いどころ）で見せて承認をもらい、`stage <repo> foundations approved`。

## 6. ④ 部品・パターン・文言

ひな形と 1 で読み取った今のアプリから下書きし、一問一答で決める。

- **部品の仕様**（`design-system/components/*.md`）: 18 部品のひな形を、このアプリに合わせて直す。聞くこと: 部品の形（ボタンの種類の使い分け、入力欄は一覧の中か枠つきか、メッセージの出し方）、要らない部品、足りない部品。
  - 先頭のメタデータの `from` に `D` の ID を書く。要らない部品はファイルを消す。足す部品は同じ形のファイルを作る（`status: draft` から）。
  - 種類の名前は土台に合わせる（HIG ならボタンは `filled`・`tinted`・`gray`・`plain`、shadcn/ui なら `default`・`secondary`・`destructive`・`outline`・`ghost`・`link`）。
  - 土台にない部品は、「目的」に、なぜ標準の手段で足りないかを書く。
- **画面の型**（`patterns.md`）: 今のアプリの画面を、どの型にするか。追加・削除・保存の操作の場所。確認か取り消しか。
- **文言**（`copy.md`）: 調子（です・ます、文末の「。」）、数字と単位、ボタンは動詞か、確認と取り消しの言い方。1 で読み取った今の文言で揺れているところを決める。
- `patterns.md` と `copy.md` は `##` の節ごとに、見出しの直後の行に `根拠: D…`。
- `README.md` の「土台」「原則の要約」「部品の一覧」（部品の名前と目的の表）を書く。ひな形の `<!-- … -->` のコメントはすべて消す。例の文は、このアプリの画面の言葉にする。
- `CHANGELOG.md` に最初の版を書く（`## 1.0.0 — <日付>`、作ったもの、根拠）。

`check.mjs --strict` を通してから、部品の一覧と、パターン・文言の要点を見せて承認をもらい、`stage <repo> components approved`。

## 7. 確かめる

1. `node <repo>/design-system/check.mjs --strict` が終了コード 0 で終わる。`warnings` があれば、それぞれ問題ないかを確かめる（`trace-orphan` は、使われない原則。消すか、使うところを足すかを尋ねる）。
2. 影響の一覧が引けることを確かめる（例: `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs trace <repo> --from P1`）。

## 8. コミット

`git status` で変わったファイルを確かめ、`docs/product/`、`docs/design-candidates/`、`design-system/` をコミットする。メッセージはリポジトリの書き方に合わせる（例: `Add the design system from the product principles: principles, tokens, component specs, patterns and copy`）。push はしない（push するかユーザーに尋ねる）。

## 終わりに

次を短く伝える。

- 作ったもの（原則の数、トークンの役割の数、部品の数、パターンと文言の節の数）と、土台
- `stages` の `outputs` は `pending` のまま。アプリのコード（部品・カタログ）を出すのは、プラグインの次の段階の出力から
- これからの変え方は `/product-design:update <変えたいこと>`、決まりのつながりは `/product-design:check`（`node design-system/check.mjs`）で確かめられること
- 画面を作る道具を使っているなら、`design-system/design-system.json` の `protected_paths` を、その道具の守るファイルに足すとよいこと（`docs/design-candidates/` は入れない。機能を作りながら候補を書き足すため）
