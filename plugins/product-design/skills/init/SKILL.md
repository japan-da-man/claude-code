---
name: init
description: アプリのデザインシステムを、プロダクトの原則から一気通貫で最初に作る。① プロダクトの原則 → ② デザインの原則 → ③ 基礎とトークン（DTCG）→ ④ 部品の仕様・画面の型・文言 → ⑤ HTML の出力 を、段ごとに一問一答で決めて承認をもらい、どの決まりにも上の段の ID を根拠として書き、機械のチェックを置き、Claude の Design System に写す。途中で止めても続きから始められる。「デザインシステムを作って」「プロダクトの原則から作って」「/product-design:init」と言われたときに使う。アプリごとに 1 回。
argument-hint: "[--base hig|shadcn] [--local]"
model: opus
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *) Bash(node *design-system/check.mjs*) Bash(git fetch *) Bash(git status*) Bash(git rev-parse *) Bash(git diff*) Bash(git add *) Bash(git commit *)
---

# product-design:init: デザインシステムを作る

引数: $ARGUMENTS

プロダクトの原則から部品の仕様までを、**人が決めて**、根拠をたどれる形で作る。画面を作る人と道具は、これに従うだけになる。設計は `${CLAUDE_PLUGIN_ROOT}/DESIGN.md`。

0. 準備 → 1. アプリを調べる → 2. 土台を選んでひな形を置く → 3. ① プロダクトの原則 → 4. ② デザインの原則 → 5. ③ 基礎とトークン → 6. ④ 部品・パターン・文言 → 7. ⑤ HTML の出力 → 8. 確かめる → 9. コミット → 10. Claude の Design System に写す、の順に進める。段ごとに承認をもらい、承認したら次の段へ進む。引数に `--local` があれば、10 の写しをしない。

質問は必ず **AskUserQuestion** で出す。本文に質問を並べない。1 回に出すのは、答えが前の答えに依存しない質問だけ（最大 4 問）。選択肢をつけ、おすすめは先頭にして「(Recommended)」を付ける。**調べれば分かること（今の値、画面の作り、プロジェクトの設定）は質問せず、自分で調べる。**

> この版の ⑤ の出力は HTML（Claude Design 用の部品の見本）だけ。アプリ用の SwiftUI と Expo の出力は、プラグインの次の段階で足す。
>
> **始める前に選んでもらう**: SwiftUI の部品とカタログが今すぐ要るアプリは、product-design を始めずに `/design-system:init` を使う。一度 product-design で始めると（`design-system.json` が v2 になると）、`/design-system:*` はそのアプリを断るので、アプリ用の出力はこのプラグインの次の段階を待つことになる。0 で `design-system.json` がなく、1 で SwiftUI のアプリだとわかったら、2 の前に AskUserQuestion でどちらにするかを確かめる。

## 0. 準備

- 対象のアプリのリポジトリを決める。`git rev-parse --show-toplevel` がアプリのリポジトリでなければ、AskUserQuestion でパスを尋ね、以降のコマンドはすべてそのパスで実行する（`cd <repo> && …`）。
- `design-system/design-system.json` があれば、`node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs status <repo>` で段の進み具合（`stages`・`next`）を見る。
  - `status` がエラーになったら、その文を読む。`version` が 2 でない（v1）なら、v1 からの移行はまだこの版にないことを伝え、今は `/design-system:update` を使うよう勧めて終える。`tokens.json` が読めないなら、JSON の誤りを直してからやり直す。
  - `next` が `null`（① から ⑤ がすべて `approved`）なら、作り直さずに `/product-design:update` を勧めて終える。
  - 途中まで進んでいれば、1 を短くやり直して（今のコードと文書を読み直す）から、`next` の段から続ける。2 は飛ばす（置いたひな形と、書いた文書はそのまま使う）。
- `git fetch -q origin` のあと `git status -sb` を見る。origin より遅れていたら pull してよいか尋ねる。まだコミットしていない変更があれば、それを伝えて続けてよいか尋ねる。

## 1. アプリを調べる

次を調べて、短い表にまとめる（ファイル:行つき。推測で埋めない）。アプリが大きければ、Explore のサブエージェントに分けて調べさせてよい。

- **出すプラットフォーム**: リポジトリの直下と、その 1 つ下（`apps/*`・`packages/*` など）を見る。先に Expo を見る（prebuild した Expo のアプリには `ios/*.xcodeproj` もあるため）。
  - `package.json` に `expo` → Expo（iOS・Android・Web のどれに出すかは `app.json` と `package.json` の scripts を見る）
  - `*.xcodeproj`・`project.yml`・`Project.swift`（Tuist）・アプリを作る `Package.swift` → SwiftUI（iOS だけ）
  - `react-native` はあるが `expo` がない、SwiftUI と Expo の両方がある、どちらもない → 2 で聞く
- **今の見た目**: コードから、色・文字・余白と角丸・部品（ボタン、入力欄、一覧の行、メッセージ、空の状態、確認）・文言（エラー、空の状態、ボタン、確認の言い方）・画面の型（一覧・編集・詳細・設定）を読み取る。同じ役割に違う値を使っている「揺れ」も拾う。
- **今の文書**: README、`docs/` の中のプロダクトの説明や原則、機能の文書（`docs/product/overview.md`、機能マスタ、要件定義書など。利用シーンや、スコープ外・非ゴールを書いたもの）。`docs/product/principles.md` がすでにあるか。

## 2. 土台を選んでひな形を置く

1. 土台を決める（`DESIGN.md` 4節）。引数に `--base` があればそれを使う。なければ 1 の結果からおすすめを決め、AskUserQuestion で確かめる。
   - iOS だけ（SwiftUI）→ `hig`（Apple HIG）
   - iOS と Android（Expo）や Web に出す → `shadcn`（shadcn/ui ＋ Tailwind）
   - Expo で iOS だけに出す → どちらにするか聞く（おすすめは `shadcn`。Expo の部品は React Native Reusables を土台にするので、名前が揃う）
2. ひな形を置く:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs install <repo> --base <hig|shadcn>
   ```

   `design-system/design-system.json`（v2。段はすべて `pending`。`outputs.html` つき）、`docs/product/principles.md`、`design-system/` の文書・`tokens.json`・`components/`（18 部品）・`check.mjs`、HTML の出力 `design-system/html/`（`tokens.css`・`base.css`・`theme.js`・`index.html`・`components/` の 18 部品の見本のページと CSS）、`docs/design-candidates/README.md` ができる。**すでにあるファイルは上書きしない**（`skipped` に出る）。`docs/product/principles.md` が `skipped` なら、もとからあった文書なので、3 では読む（形が足りなければ、足すかを尋ねる）。

## 3. ① プロダクトの原則

`docs/product/principles.md` は、デザインシステムの外の文書（仕様づくりや優先順位の判断にも使う）。

- **もとからあった**なら、読んで要約を見せる。原則の見出しに `### P1 …` の ID がなければ、付けてよいか尋ねる。断られたら、`docs/product/principles.md` は変えずに、ID つきの写しを作るかを尋ねる。作るなら:
  1. 写しを `docs/product/principles.ids.md` に置く（もとの原則を `### P1 …` の見出しに並べ直したもの。冒頭に「`docs/product/principles.md` の写し。もとを変えたら、ここも直す」と書く）。
  2. `design-system/design-system.json` の `product_principles` を写しに向け、`protected_paths` の `docs/product/principles.md` も写しの道のりに替える。
  3. `design-system/README.md` の ① のリンクを写しに向ける。
  4. もとの文書が変わっても写しは変わらないので、変えたら `/product-design:update` で写しも直すことを、ユーザーに伝える。

  もとの原則に場面や捨てるもの（下の形）がなければ、そのことを伝える。② の根拠にしにくいので、足すかを尋ねる（足すのは、ID を付けた文書か写しのほう）。足すなら、3-1・3-3・3-4 で場面と捨てるものだけを決める。もとの標語・優先の文・ID は変えず、下の「書き直してもらう原則」も当てない（もとの原則を決めた人の判断なので）。気になる原則があれば、そのことを伝えるだけにする。
- **ひな形を置いた**なら、下の 3-1〜3-5 で書き直す。ひな形の原則は仮のアプリ（レシピのアプリ）の例なので、形だけを使い、中身は残さない。

原則は、どれも次の形で書く（見出しの `### P1 …` は check が ID として読む）:

```markdown
### P1 <そのプロダクトらしい短い標語>

**<A より B を優先する。>**

- 場面: <誰が、どこで、何をしているときに、この原則で何を選ぶか>
- 捨てるもの: <この原則で失うものと、それをどこで補うか>
```

見出しの文が一般的になるのは、有名な原則でも同じ。違いは、場面と捨てるものに出る。だから、場面と捨てるものを先に集めてから、標語と「A より B」を決める。

3-1. **機能の文書を読む**（質問の前に）。README、`docs/product/overview.md`（なぜ作るか・誰のためか・スコープ外）、機能マスタと要件定義書（アクター・利用シーン・非ゴール）など、手順 1 で見つけた文書から、次を抜き出して表にする（ファイル:行つき）。
   - 使う人と、その人が困っていること
   - 利用シーン（いつ・どこで・どんな状態で使うか）
   - 大事にしていること
   - **想定していないこと**（スコープ外・非ゴール・あえてやらないこと）。原則の候補は、まずここから作る。あえてやらないことは、そのプロダクトが何を選んだかをいちばんよく表し、そのまま「捨てるもの」になる。

   文書がなければ、今の画面とコードから読み取れることだけを書き、足りない分は 3-2 で尋ねる。

3-2. **一問一答で、人と場面を決める**。
   - 誰のためのプロダクトか、その人が何に困っているか。3-1 の表から下書きを作り、選択肢にする。
   - 原則にする場面を 3〜5 個。3-1 の「想定していないこと」と利用シーンから候補を出す（このあえてやらないことは、どの場面のためか）。AskUserQuestion の選択肢は 1 問に 4 個までなので、候補を 4 個まで出して複数選んでもらい、足りなければ、ほかに足す場面があるかを続けて尋ねる。場面は、人と場所と状態まで書く（「通勤中」ではなく「満員電車で、片手でつり革を持って」のように）。
   - 候補に、どのアプリにも言える原則（標準に合わせる、誰でも使える、速い、など）を出さない。ユーザーがそれを挙げたら、② デザインの原則に回すことを伝え、① では、それが効く利用場面を名指しした原則にできるかを尋ねる。

3-3. **場面ごとに、選ぶものと捨てるものを決める**。捨てるものは、何を優先するかで変わるので、同じ呼び出しでは尋ねない。まず優先するもの（B と A）を、次の呼び出しで捨てるものを尋ねる。1 回に尋ねるのは 1〜2 個の場面ずつ。
   - その場面で、何を優先するか（B）と、そのために後回しにするもの（A）。3-1 の「大事にしていること」から下書きを作る。
   - 捨てるもの: その原則で失うもの（できなくなること・遅くなること・がっかりする人）と、それをどこで補うか（別の画面・別の時・別の手段）。3-1 の「想定していないこと」から下書きを作る。補わないなら「補わない」と書いてもらう。

3-4. **ぶつかるところに線を引く**。原則どうしを 2 つずつ見比べ、同じ場面で逆のことを求めるところ（例: 「片手ですぐ終わる」と「消す前に確認を求める」）を探す。見つけたら、どちらかの「捨てるもの」に線引きを書く（例: 「確認を求めるのは取り返しのつかない操作だけ。毎日の操作は、確認ではなく元に戻せるようにする（P1）」）。線引きはどちらに書くか、どこで線を引くかを尋ねる。

3-5. **標語を決める**。場面と捨てるものが決まってから、そのプロダクトの言葉で短く書く。下書きを 2〜3 個出して選んでもらう。

書き直してもらう原則:

- **ほかのアプリの名前に入れ替えても成り立つ原則**（「機能の多さより速さ」「新しさより標準」など）。見出しと太字の文だけでなく、場面と捨てるものまで含めた原則の全体を、別のアプリの名前に入れ替えて読んでみる（「〇〇では、…を優先する。場面: …。捨てるもの: …」）。見出しと太字の文は一般的でよい（ひな形の P1 の太字の文も、ほかのアプリで成り立つ）。場面と捨てるものまで成り立つなら、場面の人・場所・状態を具体的にして書き直す（3-2 と 3-3 に戻る）。
- **どちらを選ぶかで答えが変わらない原則**（「使いやすく」など。A を選ぶ人がいない）。
- **捨てるものがない原則**。何も失わない原則は、判断に使えない。
- **ほかの原則とぶつかったまま線引きがない原則**。3-4 に戻る。
- **「どう感じさせるか」の原則**（標準に合わせる、誰でも使える、アクセシビリティ、見た目の一貫性など）。① は「何を作るか」の原則なので、これらは ② デザインの原則に回す（手順 4 で、① のどの場面のためかを根拠にして書く）。

ID は `P1` から振る。ひな形の `<!-- … -->` のコメントは消す。

書けたら全文を見せ、AskUserQuestion で承認をもらう。承認されたら:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs stage <repo> product approved
```

## 4. ② デザインの原則

`design-system/principles.md` を、① から下書きして一問一答で決める。

- 見た目と振る舞いで迷ったときの判断を 3〜5 個。OS の標準に合わせる、アクセシビリティのような「どう感じさせるか」の原則はここに書き、① のどの場面のためかを根拠にする（手順 3 で ① から外したものも、ここに置く）。下書きは、① の場面と捨てるものから作る。見出しは `### D1 …`、**見出しの直後の行に `根拠: P1, P2`**（どのプロダクトの原則から来たか）、本文に「だから、こうする」を具体的に書く。
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

## 7. ⑤ HTML の出力

`design-system/html/` は、部品の仕様（`components/*.md`）とトークンを HTML と CSS にしたもの。Claude Design で案を作るときの部品の見本になり、10 で Claude の Design System に写す。ビルドはなく、ブラウザでそのまま開ける（`index.html` が一覧。`?theme=dark` を付けるとダーク）。

1. `tokens.css` を `tokens.json` から作り直す（手で直さない）:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs tokens <repo>
   ```

2. 部品の見本を、④ で決めた仕様に合わせて直す。部品ごとに `components/<outputs.html の名前>.html` と `.css` の 2 つ。
   - 種類・状態・構造を仕様と揃える（仕様で種類を足した・消したなら、見本も足す・消す）。例の文は、このアプリの画面の言葉にする。
   - 消した部品は、その HTML と CSS も消す。足した部品は、同じ形で 2 つ作る（`<main class="ds-page" data-group="…" data-height="…">` の中に例を並べ、`data-testid` の例を 1 つ入れる）。`index.html` の一覧も直す。
   - **CSS で使ってよいのは `tokens.css` の変数（`var(--…)`）だけ**。色・文字・余白・角丸の値を直に書かない（線の太さの 1px・2px、押せる大きさの 44px などの寸法はよい）。クラスは `ds-` で始める。Tailwind のクラスは使わない。スクリプトは `theme.js` だけ。
   - 部品の CSS が使う `var(--…)` から、トークンを変えたときに影響を受ける部品がたどれる（`cli.mjs trace`）。部品の CSS は、その部品のページだけが読む。
3. スクリーンショットを撮る（手元の Chrome。見本のページごとに、ライトとダーク）:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs screenshot <repo>
   ```

   `design-system/screenshots/html/<ページ>-light.png`・`-dark.png` ができる。`skipped` なら Chrome が見つからないので、`reason` を伝え、ユーザーにブラウザで `design-system/html/index.html` を開いて見てもらう。
4. 撮ったものを Read で見て、崩れ（はみ出し、重なり、読めない色の組、ダークで消える要素）がないかを自分で確かめてから、ユーザーに見せる。1 回の AskUserQuestion で「直したい部品（multiSelect。「直すものはない」も選べる）」を聞き、選ばれた部品だけ、1 つずつ直し方を聞いて直し、3 からやり直す。最後に承認をもらい、`stage <repo> outputs approved`。

## 8. 確かめる

1. `node <repo>/design-system/check.mjs --strict` が終了コード 0 で終わる。`warnings` があれば、それぞれ問題ないかを確かめる（`trace-orphan` は、使われない原則。消すか、使うところを足すかを尋ねる）。
2. `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs status <repo>` の `stale` が空（`tokens.css` が古ければ、7 の 1 をやり直す）。
3. 影響の一覧が引けることを確かめる（例: `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs trace <repo> --from P1`。部品には HTML の出力のファイルが `files` に付く）。

## 9. コミット

`git status` で変わったファイルを確かめ、`docs/product/`、`docs/design-candidates/`、`design-system/`（スクリーンショットも）をコミットする。メッセージはリポジトリの書き方に合わせる（例: `Add the design system from the product principles: principles, tokens, component specs, patterns, copy and the HTML components`）。push はしない（push するかユーザーに尋ねる）。

## 10. Claude の Design System に写す

`--local` なら飛ばす。正はリポジトリで、Claude の Design System には **一方向で** 写す（Claude Design で案を作るときに使う）。ページの上では直せないようにする。

1. 写すファイルを並べる（スクラッチのフォルダに）:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs artifact-stage <repo> <スクラッチのフォルダ>/artifact --title "<アプリの名前>" --by "<ユーザーの名前>"
   ```

   `root`（並べたフォルダ）、`file_path`（索引 `project/design-system.json`）、`files`（送るファイルの組。トークンは Design System の形に変えた `tokens.json` と `tokens.css`、README と各節、部品ごとの `components/<名前>/README.md`・`preview.html`、`components/bundle.css`）、`hash` が出る。
2. Design System を作る。`Artifact` の `action: "quickstart"`（`intent: "other"`）か型の一覧から **Design System** の型を選び、`type_url` と `title`（アプリの名前）で、ファイルなしで 1 回だけ作る。結果に出る型の手順（SKILL.md）を読み、それに従う。
3. 表紙を作る。型の `artifact-type/reference/cover.md` を読み（`Artifact` の `action: "read"`、`path`）、`<root>/project/components/Cover/preview.html` を、写すトークンの色と角丸から作って `files` に足す。
4. 1 回の `publish` で送る: `url` は 2 で作った Design System、`root`、`file_path` は索引、`files` は 1 と 3 のファイル。索引は `editing: "code"`（リポジトリから写すので、ページの上では直せない）。
5. 写し終えたら、url と中身のハッシュを記録して、コミットする:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs artifact-done <repo> <Design System の url>
   ```

   `design-system/design-system.json` の `artifact` が変わるので、それをコミットする（push はしない）。

## 終わりに

次を短く伝える。

- 作ったもの（原則の数、トークンの役割の数、部品の数、パターンと文言の節の数、HTML の見本のページの数）と、土台
- 見た目の確認に使ったスクリーンショットの場所と、Design System の url（非公開。ほかの人に見せるときはページの共有メニューから共有する）
- アプリ用の出力（SwiftUI・Expo の部品とカタログ）は、プラグインの次の段階から
- これからの変え方は `/product-design:update <変えたいこと>`、決まりのつながりは `/product-design:check`（`node design-system/check.mjs`）で確かめられること
- 画面を作る道具を使っているなら、`design-system/design-system.json` の `protected_paths` を、その道具の守るファイルに足すとよいこと（`docs/design-candidates/` は入れない。機能を作りながら候補を書き足すため）
