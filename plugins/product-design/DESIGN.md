# product-design 設計

プロダクトの原則からデザインシステムまでを、根拠をたどれる形で一気通貫に作り、育てるための Claude Code プラグイン `product-design` の設計。

- 状態: 設計（2026-10-28 に一問一答で方針を合意。まだ実装していない）
- 今の [design-system](../design-system/DESIGN.md) を作り直したもの。トークン・部品・チェック・カタログ・Artifact への写しは使い回し、段と根拠のつながりを足し、特定の使う側（factory など）への言及をなくす
- 出力: Claude Design 用の HTML はいつも作る。アプリ用は SwiftUI か Expo（React Native）を、実行のときに選ぶ

## 1. 考え方

- **上の段から下の段へ、根拠をたどれるように作る**。プロダクトの原則 → デザインの原則 → 基礎とトークン → 部品・パターン・文言 → 各プラットフォームへの出力。下の段の決まりは、どれも上の段のどれかを根拠に持つ。根拠を持てない決まりは、上の段が足りないサイン。
- **一気通貫の価値は、最初に一度に作れることより、変えたときに下まで届くこと**。上の段を変えたら、影響する下の段を機械で一覧にして、まとめて直す。
- **決まりは人が決める**。どの段も一問一答で決め、承認をもらってから次へ進む。どの段からでも始め直せる。
- **使う側を知らない**。このプラグインは決まりと部品と機械のチェックを置くだけで、どの道具が使うかは知らない。使う側（画面の案を作る道具、実装する道具、人）は、置かれたファイルを読み、チェックを実行し、足りないものを候補として書く。
- **正はアプリのリポジトリの中**。テキストとコードで持つので、LLM が読めて、差分とレビューと版が使える。Claude の Design System には一方向で写すだけにする。
- **よく使われている土台に則る**。役割の名前や部品は自分で発明せず、iOS だけのアプリなら Apple HIG、複数のプラットフォームに出すなら shadcn/ui と Tailwind に則る（4節）。LLM が学習でよく知っている形のほうが、生成された UI がずれにくい。

## 2. 決まったこと

| 項目 | 決定 |
| :- | :- |
| 名前 | `product-design`。コマンドは `/product-design:init`・`/product-design:update`・`/product-design:check` |
| 今の design-system との関係 | 作り直す（フォルダの名前も変える）。init 済みのアプリは update で移せる（16節） |
| 段 | ① プロダクトの原則 → ② デザインの原則 → ③ 基礎とトークン → ④ 部品・パターン・文言 → ⑤ 出力（3節） |
| 根拠 | 原則に `P1`・`D1` のような ID を付け、下の段は上の段の ID を書く。check がつながりを確かめ、update が影響を一覧にする（5節） |
| 土台 | iOS だけのアプリは **Apple HIG**。iOS と Android（Expo）や Web に出すアプリは **shadcn/ui ＋ Tailwind**（iOS での値は HIG に寄せる）。init で選ぶ（4節） |
| トークンの形式 | **DTCG 2025.10**（W3C Design Tokens Community Group の安定版）。基本と意味の 2 段（8節） |
| 出力 | **HTML（Claude Design 用）はいつも作る**。アプリ用の SwiftUI か Expo は、リポジトリを見て判断し、判断がつかなければ聞く（10節） |
| Claude Design | Claude の Design System に一方向で写す。足りないものは、案の中の「部品の候補」と `update` が案を読むことで戻す（11節・12節） |
| 足りないものが見つかったとき | 案づくりは止めず、ある部品とトークンで仮の形を組んで候補として記録する。決まりにするかは人が `update` で決める。実装の前に決着させる（12節） |
| 運用 | 版（semver）、`CHANGELOG.md`、DTCG の `$deprecated` と部品の状態、`candidates.md`（13節） |
| 使う側 | プラグインの中では特定の道具に触れない。設定 `design-system.json` を、どの道具でも読める入口にする（14節） |
| 質問の形 | AskUserQuestion による一問一答（選択肢つき、おすすめを先頭に「(Recommended)」、答えが前の答えに依存しない質問だけを最大 4 問まとめる） |
| スクリプト | Node の標準機能だけ。`node --test` のテストを先に書く |

## 3. 段と成果物

| 段 | 置き場所 | 中身 | 根拠 |
| :- | :- | :- | :- |
| ① プロダクトの原則 | `docs/product/principles.md` | 誰のために何を作るか。優先順位を「A より B」の形で 3〜5 個 | ID `P1`… |
| ② デザインの原則 | `design-system/principles.md` | 見た目と振る舞いを迷ったときの判断を 3〜5 個。それぞれ「だから、こうする」を具体的に書く | ID `D1`…。どの `P` から来たか |
| ③ 基礎とトークン | `design-system/foundations.md`、`design-system/tokens.json` | 色・文字・余白とレイアウト・角丸・影・動き・アイコン・アクセシビリティの最低線。トークンは基本と意味の 2 段 | 意味の段のトークンと基礎の決まりに `D` |
| ④ 部品・パターン・文言 | `design-system/components/*.md`、`patterns.md`、`copy.md` | プラットフォームに依らない仕様（構造・種類・状態・使う場面と使わない場面・アクセシビリティ・文言）、画面の型、文言の決まり | どれにも `D` |
| ⑤ 出力 | HTML: `design-system/html/`、SwiftUI: `<アプリ>/DesignSystem/`、Expo: `<アプリ>/design-system/` | 仕様とトークンから作る実装・カタログ・機械のチェック | 実装は部品の仕様を指す |

- ① はデザインシステムの外に置く。仕様づくりや優先順位の判断など、ほかの道具も読むため。すでにあれば読むだけにして飛ばす（ID がなければ、付けてよいか尋ねる）。
- 段ごとに、変わる頻度と決める人が違う（① はめったに変わらず、決めるのは創業者や PM。④ は頻繁に変わり、決めるのはデザイナーや開発者）。だから段ごとに承認をもらい、どの段からでも始め直せるようにする。
- 今のアプリのコードがあれば、③④ の下書きはコードから読み取る（今の design-system の init と同じ）。コードがなければ、土台（4節）の値から始める。

## 4. 土台の選び方

init で、アプリが出すプラットフォームを見て選ぶ。あとから変えるのは大きな変更（メジャー版）。

| アプリ | 土台 | 役割の名前 | iOS での値 |
| :- | :- | :- | :- |
| iOS だけ（SwiftUI） | **Apple HIG** | HIG の名前（`label`・`secondary-label`・`system-background`・`tint`…）と Dynamic Type の 11 段 | HIG のシステムの色にそのまま対応させ、ダークモードやコントラストを上げる設定は OS に任せる |
| iOS と Android（Expo）や Web | **shadcn/ui ＋ Tailwind** | shadcn/ui の名前（`background`/`foreground` の組、`primary`・`muted`・`destructive`・`border`・`ring`…）。基本の段は Tailwind のスケール | 原則で「iOS の標準に寄せる」と決めたら、HIG の値を初めの値にする |

選んだ理由（2026-10-28 の調査）:

- **HIG**: iOS ではいちばん自然で、システムの色と Dynamic Type が OS の設定にタダでついてくる。一方で、値ではなく OS の機能として提供されるので HTML や Expo に持ち出しにくく、Web や Expo の部品の土台がなく、Android ではちぐはぐになり、SF Pro は Web フォントとして配れない。だから iOS だけのアプリに限る。
- **shadcn/ui ＋ Tailwind**: HTML（shadcn/ui）と Expo（React Native Reusables ＋ NativeWind）で同じ名前を使え、SwiftUI には名前を対応させるだけで済む。State of React 2024 で使っている人が 20% → 42% に倍増し、2025 年は利用 1 位の MUI に迫る。v0 など AI の UI 生成の道具の土台でもあり、LLM がよく知っている。ただし部品の集まりで、デザインシステムとしては足りないところがあるので補う（文字の段、`success`・`warning`・`info` の色、影、動き）。
- **Material 3** は、いちばん全部そろっているが、iOS では Android らしく見え、LLM が作る Web の UI の書き方とも少し違うので、土台にはしない。影と動きの考え方だけ借りる。

どちらの土台でも、HIG や shadcn/ui が決めない「このアプリらしさ」は自分で決める（ブランドの色、余白の刻み、iOS や shadcn/ui にない部品、使い分け、文言、画面の型、対応の範囲）。それを決めるのが ②〜④ の一問一答。

## 5. 根拠のつながり

### 書き方

- プロダクトの原則: `docs/product/principles.md` の見出しに ID を付ける。

  ```markdown
  ### P1 機能の多さより、毎日の操作の速さを優先する
  ```

- デザインの原則: `design-system/principles.md` の見出しに ID、本文の最初の行に根拠を書く。

  ```markdown
  ### D1 1 画面の目的は 1 つにする
  根拠: P1

  だから、1 つの画面に主なボタンは 1 つだけ置く。…
  ```

- トークン: 意味の段のトークンの `$extensions` に書く（基本の段は書かなくてよい）。

  ```json
  "primary": {
    "$value": "{color.blue.600}",
    "$description": "主なボタン、選ばれている状態、リンク",
    "$extensions": { "com.github.japan-da-man.product-design": { "from": ["D1"] } }
  }
  ```

- 部品・パターン・文言・基礎: 文書の頭（部品はファイルの先頭のメタデータ）に `from: [D1, D3]` を書く。パターンと文言と基礎は、節ごとに `根拠: D2` を書く。
- ID は消しても使い回さない（消した ID は `principles.md` の最後に「廃止」として残す）。

### チェック（check の一部）

| 決まり | 落とすもの |
| :- | :- |
| `trace-missing` | 実在しない ID を指している |
| `trace-none` | 意味の段のトークン・部品・パターン・文言の節・デザインの原則に、根拠がない |
| `trace-orphan` | どこからも使われない原則（警告。違反にはしない） |
| `trace-deprecated` | 廃止された原則や、`$deprecated` のトークン・部品を、ほかの決まりが使っている |

### 影響の一覧

`update` で上の段を変えるとき、変えるものから下へたどって、影響を受けるものを一覧にする（`cli.mjs trace --from P1` で、P1 → D → トークン・部品・パターン・文言 → 出力のファイル）。人はこの一覧を見て、どこまで直すかを決める。

## 6. 全体の流れ

```text
/product-design:init        アプリごとに 1 回（途中で止めて、あとから続けられる）
  0. 準備: 対象のリポジトリ。design-system.json があれば、続きから始めるか update を勧める
  1. アプリを調べる: 出すプラットフォーム（10節）、今のコード、今の文書（README、docs/）
  2. ① プロダクトの原則: あれば読む。なければ一問一答で作る → 承認
  3. ② デザインの原則: ① から下書きを作り、一問一答で決める → 承認
  4. 土台を選ぶ（4節）
  5. ③ 基礎とトークン: 今のコードと土台から下書き → 一問一答 → 承認
  6. ④ 部品・パターン・文言: ひな形と今のコードから下書き → 一問一答 → 承認
  7. ⑤ 出力: 選んだ出力ごとに、ひな形を置いて仕様とトークンに合わせて直す。今の画面も部品とトークンで書き換える
  8. 確かめる: check（根拠と出力のチェック）、ビルドと全テスト、カタログのスクリーンショット（ライト／ダーク、書き換えの前後）
  9. スクリーンショットを見せて承認（直したいところだけ対話で直す → 8 へ）
  10. コミットする。Claude の Design System に写す（--local なら写さない）

/product-design:update <変えたいこと | 候補 | Claude Design の案の URL>
  1. 何を変えるかを判断し、どの段の変更かを決める（候補なら 12節の流れ）
  2. 影響の一覧を出す（5節）
  3. 一問一答で変え方を決める → その段を直す → 影響を受ける下の段を順に直す
  4. 変更でチェックに合わなくなったアプリのコードも直す
  5. 確かめる（check、ビルドと全テスト、変わった前後のスクリーンショット）→ 承認
  6. 版を上げて CHANGELOG.md を書き、コミットする。Claude の Design System に写す

/product-design:check
  根拠のつながり、出力ごとのコードのチェック、古くなったもの（生成したコード、写したチェック、Design System）を一覧にする。直さない
```

段ごとの進み具合は `design-system.json` の `stages` に書く（`pending`・`approved`）。init はこれを見て続きから始める。

## 7. 置き場所

対象アプリのリポジトリの中:

```text
docs/product/
  principles.md          ① プロダクトの原則（ほかの道具も読む）
design-system/
  design-system.json     設定。使う側が最初に読む入口（14節）
  README.md              入口の文書。土台、原則の要約、トークンの使いどころ、部品の一覧、足りないときの決まり
  principles.md          ② デザインの原則
  foundations.md         ③ 基礎（色・文字・余白とレイアウト・角丸・影・動き・アイコン・アクセシビリティ）
  tokens.json            ③ トークン（DTCG 2025.10）
  components/*.md        ④ 部品の仕様（1 部品 1 ファイル）
  patterns.md            ④ 画面の型と使い分け
  copy.md                ④ 文言の決まり
  candidates.md          足りないものの候補（使う側の誰でも書く。12節）
  CHANGELOG.md           版ごとの変更
  check.mjs              機械のチェック（プラグインから写したもの。手で直さない）
  shoot.mjs              スクリーンショット（同上）
  html/                  ⑤ HTML の出力（tokens.css、部品、見本のページ）
  screenshots/           カタログのスクリーンショット（<出力>/<ページ>-light.png / -dark.png）
<アプリ>/DesignSystem/     ⑤ SwiftUI の出力（Tokens.swift、Components/、Catalog/）
<アプリ>/design-system/    ⑤ Expo の出力（tokens.ts、global.css、components/、catalog/）
```

## 8. トークン `tokens.json`（DTCG 2025.10）

```json
{
  "color": {
    "$type": "color",
    "blue": {
      "600": { "$value": { "colorSpace": "srgb", "components": [0, 0.392, 0.824], "hex": "#0064d2" } }
    },
    "primary": {
      "$value": "{color.blue.600}",
      "$description": "主なボタン、選ばれている状態、リンク",
      "$extensions": {
        "com.github.japan-da-man.product-design": {
          "from": ["D1"],
          "modes": { "dark": "{color.blue.400}" },
          "swiftui": { "system": "tint" }
        }
      }
    }
  },
  "space": {
    "$type": "dimension",
    "2": { "$value": { "value": 8, "unit": "px" } }
  }
}
```

- **2 段**: 基本の段（`color.blue.600`・`space.2` などの生の値）と意味の段（役割の名前）。部品の段は、部品ごとに色を変える必要が出たら足す。アプリのコードとチェックが許すのは意味の段だけ。
- **基本の段**は Tailwind のスケールに合わせる（余白は 4px 刻み、色は 50〜950 の段）。HIG を土台にするときも同じ（HIG には余白の刻みがない）。
- **意味の段の必ずある役割**（ひな形の部品が使う）:

  | | HIG | shadcn/ui ＋ Tailwind |
  | :- | :- | :- |
  | 色 | `tint`・`label`・`secondary-label`・`tertiary-label`・`placeholder-text`・`separator`・`system-background`・`secondary-system-background`・`system-grouped-background`・`secondary-system-grouped-background`・`destructive`・`warning`・`success`・`info` | `background`/`foreground`・`card`/`card-foreground`・`primary`/`primary-foreground`・`secondary`/`secondary-foreground`・`muted`/`muted-foreground`・`accent`/`accent-foreground`・`destructive`/`destructive-foreground`・`success`/…・`warning`/…・`info`/…・`border`・`input`・`ring` |
  | 文字 | Dynamic Type の 11 段（`large-title`・`title-1`・`title-2`・`title-3`・`headline`・`body`・`callout`・`subheadline`・`footnote`・`caption-1`・`caption-2`） | 18節の未解決の点 |
  | 余白・角丸 | `space.1`〜`space.8`、`radius.sm`・`radius.md`・`radius.lg` | 同じ（角丸は shadcn/ui の `radius` から作る） |
  | 影・動き | `shadow.sm`・`shadow.md`、`duration.fast`・`duration.normal`、`easing.standard` | 同じ |

- **ダークモード**: DTCG 2025.10 の本体にはテーマの切り替えがないので、ダークの値は `$extensions` の `modes` に書く。DTCG の別の仕組み（Resolver）が使えるようになったら移す（18節）。
- **SwiftUI での対応**: HIG を土台にするとき、`$extensions` の `swiftui.system` にシステムの色の名前を書けば、`Tokens.swift` はその色をそのまま使う（OS の切り替えを活かす）。書かなければ値から作る。
- 役割は足してよい（名前は小文字の kebab-case）。足したものも各出力に生成される。
- 値の検証: DTCG の形（`$value` が必須、参照先が実在する、循環しない）、必ずある役割の欠け、文字に使う色の組のコントラスト比（4.5:1 未満は違反）。

## 9. 部品の仕様 `components/*.md`

プラットフォームに依らない形で書き、各出力はこれを実装する。

```markdown
---
name: button
status: stable          # draft・stable・deprecated
from: [D1, D3]
outputs: { swiftui: DSButton, expo: Button, html: ds-button }
---

# ボタン

## 目的 / 構造 / 種類 / 状態 / 使う場面と使わない場面 / アクセシビリティ / 文言
```

- **最初に作る部品**（今の design-system の 18 種類を引き継ぐ）: ボタン、アイコンのボタン、1 行の入力、伏せ字の入力、複数行の入力、オン・オフ、選択、一覧の行、一覧の見出し、その場のメッセージ、バナー、トースト、アラート、確認、空の状態、読み込み中、印、カード。
- **種類の名前は土台に合わせる**。shadcn/ui ならボタンは `default`・`secondary`・`destructive`・`outline`・`ghost`・`link`。HIG ならボタンのスタイル（filled・tinted・gray・plain）と役割（destructive など）。
- **土台にない部品**（HIG のトーストやバナー、その場のメッセージ、チップ、カードなど）は、仕様の「目的」に、なぜ標準の手段で足りないかを書く。
- **識別子**: どの出力でも、呼び出し側からアクセシビリティの識別子を渡せるようにする（UI テストや画面を操作する道具が使う）。

## 10. 出力

出力は差し替えられる部品として作る。どの出力も同じ 5 つを持つ。

| 持つもの | HTML | SwiftUI | Expo |
| :- | :- | :- | :- |
| トークンの生成 | `tokens.css`（CSS 変数。ダークは `prefers-color-scheme` と `data-theme`） | `Tokens.swift`（`DS.Color`・`DS.Font`・`DS.Space`・`DS.Radius`） | `tokens.ts` と `global.css`（NativeWind の CSS 変数） |
| 部品 | HTML と CSS（ビルドなし）。shadcn/ui を土台にするなら構造とクラスを shadcn/ui に合わせ、HIG なら iOS の見た目をまねる | SwiftUI の標準の部品を包む（今の design-system のひな形） | React Native Reusables を土台にする |
| カタログ | 部品ごとの見本のページ（Claude の Design System に写す） | `#if DEBUG` のカタログ画面（起動引数 `-DesignSystemCatalog <ページ>`） | 開発のときだけ開くカタログの画面 |
| コードのチェック | なし（生成物なので） | 今の `check.mjs` の Swift の決まり（`color`・`font`・`spacing`・`control`） | TSX の直書きの色・文字・余白と、部品を通さない `Pressable`・`TextInput` など |
| スクリーンショット | ブラウザーで撮る | シミュレーターで撮る（今の `shoot.mjs`） | シミュレーターで撮る |

- **選び方**: `package.json` に `expo` がある → Expo。`*.xcodeproj` か `project.yml` がある → SwiftUI。どちらもないか、判断がつかない → 聞く。選んだ出力は `design-system.json` の `outputs` に書き、あとから update で足したり変えたりできる。
- **HTML とアプリ用のずれ**: 同じ部品の HTML 版とアプリ用の版のスクリーンショットを、カタログのページごとに並べて見せ、承認のときに見比べる。
- **Expo の部品を Web に描いて HTML の見本に使う**（react-native-web）ことができれば、Expo では部品の実装が 1 つで済む。できるかは 4 段階目で確かめる（17節・18節）。
- **シミュレーターの使用中の印**: この Mac ではシミュレーターを 1 台ずつしか使えないので、撮影の前に共通の印（`~/Library/Caches/ios-simulator.lock`、生きているプロセスの pid）を確かめ、使用中なら撮らずに知らせる。撮るあいだは自分も印を置く。ほかの道具にも同じ印を使ってもらう。

## 11. Claude の Design System への写し

- 正はリポジトリ。init と update の最後に、Claude の Design System（Artifact の型）へ **一方向で** 写す（ページ上の編集は止める）。単独の Claude Design（claude.ai/design）は 2026-12-14 までに閉じて Claude の中に移るので、写し先は Claude の Design System にする。
- 写すもの: `tokens.json`、文書（README・principles・foundations・components・patterns・copy）、HTML の部品と見本のページ、アプリ用の出力のスクリーンショット、表紙。
- **Claude Design への決まり**も写す（README の節として）: 「この部品とトークンだけで案を組む。足りないものは、ある部品とトークンで仮の形を組み、案の下に『部品の候補』として、どの画面で何のために何が足りないかを書く」。
- 写したら、写した中身のハッシュを `design-system.json` の `artifact.hash` に書く。check はハッシュが今のファイルと違えば「Design System が古い」と知らせる。
- 写せるのは、Artifact のツールが使える手元のセッションだけ。`--local` なら写さない。

## 12. 足りないものが見つかったとき

UI の案を作っている途中で、デザインシステムに足りないものが見つかるのはふつうのことで、デザインシステムを育てる主な入口になる。

```text
UI の案をつくる（Claude Design、仕様づくりの案出しなど）
  │ 足りないものが見つかる
  ├─ 1. 標準の別の手段で足りるか確かめる（例: iOS にトーストはないが、その場の表示や「取り消す」で足りるか）
  ├─ 2. 足りなければ、ある部品とトークンだけで仮の形を組み、案は先に進める（直書きの値は使わない）
  └─ 3. 候補として記録する（candidates.md か、案の下の「部品の候補」）
        │
/product-design:update で決める（人）
  ├─ 決まりにする → 足りなかった段を直す → 各出力の実装 → Design System に写し直す → 案を正式な部品で作り直す
  ├─ この画面だけの例外にする → 理由つきで記録する（チェックは通るが、数は残る）
  └─ 採らない → ある部品で案を作り直す
        │
実装へ（未決の候補が残っていたら進まない）
```

| 足りないもの | 例 | 戻る段 |
| :- | :- | :- |
| トークン | 「強調」の色、もう一段大きい余白 | ③ |
| 部品 | チップ、星の評価、段階の表示 | ④ 部品 |
| 使い分け | シートか push か、削除は確認か取り消しか | ④ パターン |
| 文言 | この状況の言い方 | ④ 文言 |
| 判断の根拠 | 原則どうしがぶつかる、原則では決められない | ②（場合によっては ①）。影響の一覧を出して下の段まで直す |

- **決まりにする目安**: 2 つ以上の画面で必要になったら。1 つの画面だけなら、まず例外にする。どの `D` を根拠にするか言えないなら、② を見直す。
- **候補の戻し方**: Claude Design の中の Design System は一方向の写しなので、Claude Design からは書き戻せない。`update` に Claude Design の案（Artifact の URL か HTML）を渡すと、案の下の「部品の候補」を拾って `candidates.md` に足す。ほかの道具は `candidates.md` に直接書く。
- **`candidates.md` の形**: 候補ごとに、見出し（短い名前）、`status`（`open`・`adopted`・`exception`・`rejected`）、どの画面で、何のために、何が足りないか、仮の形（どの部品とトークンで組んだか）、決めた日と理由。
- **実装の前の決着**: check は、`open` の候補を「未決」として出す。使う側は、実装の前にこれが 0 件であることを確かめられる。

## 13. 運用

- **版**: `design-system.json` の `ds_version`（semver）。
  - メジャー: 役割や部品を消す・名前を変える、土台を変える（アプリのコードが壊れる）
  - マイナー: 役割・部品・種類・パターンを足す、原則を変える
  - パッチ: 値の調整、文書の直し
- **変更履歴**: update のたびに `CHANGELOG.md` に、版、日付、変えたこと、根拠（どの ID）、影響を受けたファイルを書く。
- **廃止**: トークンは DTCG の `$deprecated`（理由と置き換え先の文字列）、部品は `status: deprecated` と置き換え先。check は廃止されたものを使うコードを「廃止」として出す（違反にはしない）。次のメジャー版で消す。

## 14. 設定 `design-system/design-system.json`（v2）

使う側が最初に読む入口。

```json
{
  "version": 2,
  "ds_version": "1.0.0",
  "base": "hig",
  "stages": { "product": "approved", "design": "approved", "foundations": "approved", "components": "approved", "outputs": "approved" },
  "product_principles": "docs/product/principles.md",
  "docs": ["design-system/README.md", "design-system/principles.md", "design-system/foundations.md", "design-system/components/", "design-system/patterns.md", "design-system/copy.md"],
  "tokens": "design-system/tokens.json",
  "candidates": "design-system/candidates.md",
  "outputs": {
    "html": { "dir": "design-system/html" },
    "swiftui": {
      "project": "FactorySample.xcodeproj", "scheme": "FactorySample", "bundle_id": "com.japandaman.FactorySample",
      "device": "iPhone 17", "code": "FactorySample/DesignSystem", "sources": ["FactorySample"]
    }
  },
  "protected_paths": ["design-system/**", "docs/product/principles.md", "FactorySample/DesignSystem/**"],
  "check": { "command": "node design-system/check.mjs" },
  "artifact": { "url": "https://claude.ai/artifact/…", "hash": "…" }
}
```

- `protected_paths`: このプラグインが持つファイル。使う側は、機能を作るときにここを変えない（変えるのは update だけ）。
- `check.command`: 使う側が実行するコマンド。違反があれば終了コード 1。`--json` で `{ ok, violations, stale, deprecated, candidates, allowed }`。
- v1 にあった `platform` と `ios` は、v1 を読む道具のために、`outputs.swiftui` があるあいだは同じ値で残す（16節）。

## 15. プラグインの構成

```text
plugins/product-design/
  .claude-plugin/plugin.json
  package.json                 node --test
  DESIGN.md
  skills/
    init/SKILL.md              /product-design:init
    update/SKILL.md            /product-design:update
    check/SKILL.md             /product-design:check
  scripts/
    check.mjs                  トークンの検証、根拠のチェック、各出力のコードのチェック（1 ファイルで完結。アプリに写す）
    cli.mjs                    スキルから呼ぶ CLI（install / tokens / trace / status / screenshot / migrate / artifact-stage / artifact-done）
    shoot.mjs                  スクリーンショット（アプリに写す）
    outputs/                   出力ごとの生成（html.mjs / swiftui.mjs / expo.mjs）
  templates/
    product/principles.md      ① のひな形
    docs/                      ②〜④ の文書のひな形
    tokens/hig.json            土台ごとの最初のトークン
    tokens/shadcn.json
    components/                部品の仕様のひな形
    html/ swiftui/ expo/       出力ごとの部品とカタログのひな形
  tests/                       node --test
```

## 16. 今の design-system からの移行

- **プラグイン**: `plugins/design-system/` を `plugins/product-design/` に移し、marketplace・bundle・README を直す。
- **特定の使う側への言及をなくす**: スキル・スクリプト・ひな形の中にある factory への言及（22 か所）を、どの道具にも通じる言葉に直す。
  - `shoot.mjs` の、factory のラインが動いているかを見る処理 → 共通のシミュレーターの使用中の印（10節）
  - 「部品の候補」を PR のレポートから受け取る流れ → `candidates.md`（12節）
  - 文書のひな形の「factory の実装役は従う」など → 「画面を作る人と道具は従う」
- **使う側の対応は、それぞれの道具の側で行う**（このプラグインの PR には入れない）。v2 の設定は v1 の項目を残すので、使う側が対応するまでも動く。
- **init 済みのアプリ（v1）**: `update` が v1 を見つけたら、移行を提案する（`cli.mjs migrate`）。今の `tokens.json` を DTCG の意味の段に移し（基本の段は値から作る）、文書を ②〜④ の形に分け、① と ② は一問一答で作る（v1 の README の「原則」を下書きにする）。今の SwiftUI の部品とカタログはそのまま使う。

## 17. 作る順番

1. **土台**: 名前を変える（16節）。①〜④ の段（ひな形と一問一答）、DTCG のトークンと検証、根拠のチェックと影響の一覧（5節）、`candidates.md`、版と CHANGELOG。プラットフォームに依らない部分。
2. **HTML の出力**と、Claude の Design System への写し（いつも要るので先に作る）。
3. **SwiftUI の出力**を今のものから作り直し、v1 からの移行を作る。
4. **Expo の出力**（`tokens.ts`・`global.css`・React Native Reusables を土台にした部品・カタログ・TSX のチェック）。react-native-web で部品を HTML の見本に使えるかを確かめる。

3 と 4 は、次に作るアプリが SwiftUI か Expo かで、先にやるほうを入れ替えてよい。

## 18. リスクと未解決の点

- **shadcn/ui を土台にするときの文字の段**。shadcn/ui には文字の段がない。HIG の Dynamic Type の名前（iOS が中心のアプリ）と、Material 3 の文字の段（Android も同じくらい大事なアプリ）のどちらにするかを、1 段階目で決める。
- **DTCG のテーマ**。DTCG 2025.10 の本体はダークモードなどのテーマの切り替えを持たないので、当面は `$extensions` の `modes` に書く。DTCG の Resolver の仕組みが安定したら移す。
- **HIG の値の写し**。HTML の出力で iOS をまねるとき、システムの色の値は HIG に載っている値を書き写すので、OS の版で値が変わるとずれる。SwiftUI の出力はシステムの色をそのまま使うので、ずれは HTML の側にだけ出る。
- **HTML とアプリ用の部品のずれ**。同じ仕様から別々に実装するので、ずれは残る。スクリーンショットを並べて見比べることで補う。Expo では react-native-web で 1 つにできるかもしれない（4 段階目で確かめる）。
- **SF Pro**。ライセンスが Apple の OS 向けのソフトの画面の案を作る用途に限られるので、HTML の出力では Web フォントとして埋め込まず、`system-ui` を指定する。
- **根拠のチェックは形だけを見る**。ID がつながっているかは確かめられるが、その根拠が本当に筋が通っているかは確かめられない。そこは各段の承認で人が見る。
- **原則の質**。「使いやすく」のような、判断に使えない原則になりやすい。一問一答では「A より B」の形と「だから、こうする」を必ず書かせ、どちらを選ぶかで答えが変わらない原則は書き直してもらう。
- 今の design-system から引き継ぐもの: チェックは正規表現でコードを見るので見逃しや誤検知がある（`allow` のコメントで逃がす）、カタログは部品を並べた画面なので組み合わせた見た目までは保証しない。
