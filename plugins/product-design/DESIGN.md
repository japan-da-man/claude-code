# product-design 設計

プロダクトの原則からデザインシステムまでを、根拠をたどれる形で一気通貫に作り、育てるための Claude Code プラグイン `product-design` の設計。

- 状態: 設計（2026-10-28 に一問一答で方針を合意。2026-10-29 にレビューの指摘を反映。まだ実装していない）
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
| 今の design-system との関係 | 新しいフォルダ `plugins/product-design/` に作り直す。init 済みのアプリは update で移せる。古いプラグインは、移行と使う側の対応が済むまで残す（16節）。アプリの中の `design-system/` と `design-system.json` の名前は変えない |
| 段 | ① プロダクトの原則 → ② デザインの原則 → ③ 基礎とトークン → ④ 部品・パターン・文言 → ⑤ 出力（3節） |
| 根拠 | 原則に `P1`・`D1` のような ID を付け、下の段は上の段の ID を書く。check がつながりを確かめ、update が影響を一覧にする（5節） |
| 土台 | iOS だけのアプリは **Apple HIG**。iOS と Android（Expo）や Web に出すアプリは **shadcn/ui ＋ Tailwind**（iOS での値は HIG に寄せる）。init で選ぶ（4節） |
| トークンの形式 | **DTCG 2025.10**（W3C Design Tokens Community Group の安定版）。基本と意味の 2 段（8節） |
| 出力 | **HTML（Claude Design 用）はいつも作る**。アプリ用の SwiftUI か Expo は、リポジトリを見て判断し、判断がつかなければ聞く（10節） |
| Claude Design | Claude の Design System に一方向で写す。足りないものは、案の中の「部品の候補」と `update` が案を読むことで戻す（11節・12節） |
| 足りないものが見つかったとき | 案づくりは止めず、ある部品とトークンで仮の形を組んで候補として記録する。決まりにするかは人が `update` で決める。実装の前に決着させる（12節） |
| 運用 | 版（semver）、`CHANGELOG.md`、DTCG の `$deprecated` と部品の状態（13節）。候補は `docs/design-candidates/`（12節） |
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
| ⑤ 出力 | HTML: `design-system/html/`、SwiftUI: `<アプリ>/DesignSystem/`、Expo: `<アプリ>/src/design-system/`（10節） | 仕様とトークンから作る実装・カタログ・機械のチェック | 実装は部品の仕様を指す |

- ① はデザインシステムの外に置く。仕様づくりや優先順位の判断など、ほかの道具も読むため。すでにあれば読むだけにして飛ばす（ID がなければ、付けてよいか尋ねる）。
- 段ごとに、変わる頻度と決める人が違う（① はめったに変わらず、決めるのは創業者や PM。④ は頻繁に変わり、決めるのはデザイナーや開発者）。だから段ごとに承認をもらい、どの段からでも始め直せるようにする。
- 今のアプリのコードがあれば、③④ の下書きはコードから読み取る（今の design-system の init と同じ）。コードがなければ、土台（4節）の値から始める。

## 4. 土台の選び方

init で、アプリが**出すプラットフォーム**を見て選ぶ（出力の種類ではない）。あとから変えるのは大きな変更（メジャー版）。

| アプリ | 土台 | 役割の名前 | iOS での値 |
| :- | :- | :- | :- |
| iOS だけ（SwiftUI） | **Apple HIG** | HIG の名前（`label`・`secondary-label`・`system-background`・`tint`…）と Dynamic Type の 11 段。HIG にない役割（`warning`・`success`・`info` など）は、独自に足したものとして分けて書く | HIG のシステムの色にそのまま対応させ、ダークモードやコントラストを上げる設定は OS に任せる |
| iOS と Android（Expo）や Web | **shadcn/ui ＋ Tailwind** | shadcn/ui の名前（`background`/`foreground` の組、`primary`・`muted`・`destructive`・`border`・`ring`…）。基本の段は Tailwind のスケール | 原則で「iOS の標準に寄せる」と決めたら、HIG の値を初めの値にする |

- Expo で iOS だけに出すアプリは、どちらにするかを聞く。おすすめは shadcn/ui（Expo の部品は React Native Reusables を土台にするので、名前が揃う）。

選んだ理由（2026-10-28 の調査）:

- **HIG**: iOS ではいちばん自然で、システムの色と Dynamic Type が OS の設定にタダでついてくる。一方で、値ではなく OS の機能として提供されるので HTML や Expo に持ち出しにくく、Web や Expo の部品の土台がなく、Android ではちぐはぐになり、SF Pro は Web フォントとして配れない。だから iOS だけのアプリに限る。
- **shadcn/ui ＋ Tailwind**: HTML（shadcn/ui）と Expo（React Native Reusables ＋ NativeWind）で同じ役割の名前を使え、SwiftUI には名前を対応させるだけで済む（CSS 変数の書き方や色空間は出力ごとに変える。10節）。State of React 2024 で使っている人が 20% → 42% に倍増し、2025 年は利用 1 位の MUI に迫る。v0 など AI の UI 生成の道具の土台でもあり、LLM がよく知っている。ただし部品の集まりで、デザインシステムとしては足りないところがあるので補う（文字の段、`success`・`warning`・`info` の色、影、動き）。
- **Material 3** は、いちばん全部そろっているが、iOS では Android らしく見え、LLM が作る Web の UI の書き方とも少し違うので、土台にはしない。影と動きの考え方だけ借りる。

どちらの土台でも、HIG や shadcn/ui が決めない「このアプリらしさ」は自分で決める（ブランドの色、余白の刻み、iOS や shadcn/ui にない部品、使い分け、文言、画面の型、対応の範囲）。それを決めるのが ②〜④ の一問一答。

## 5. 根拠のつながり

### 書き方

check が読む形は、ファイルの種類ごとに 1 つだけにする。

| ファイル | 書き方 |
| :- | :- |
| `docs/product/principles.md` | `### P1 …` の見出しに ID |
| `design-system/principles.md` | `### D1 …` の見出しに ID。見出しの直後の行に `根拠: P1, P2` |
| `foundations.md`・`patterns.md`・`copy.md` | 決まりごとの `##` の見出しの直後の行に `根拠: D1, D2`（文書の頭には書かない） |
| `components/*.md` | ファイルの先頭のメタデータに `from: [D1, D3]` |
| `tokens.json` | 意味の段のトークンの `$extensions` に `from`。グループに書けば、中のトークンが受け継ぐ（8節） |

```markdown
### P1 機能の多さより、毎日の操作の速さを優先する
```

```markdown
### D1 1 画面の目的は 1 つにする
根拠: P1

だから、1 つの画面に主なボタンは 1 つだけ置く。…
```

- **廃止**: ID は消しても使い回さない。消した原則は、その文書の最後の `## 廃止` の下に `### D4 …（廃止: 理由。置き換え: D6）` の形で残す。
- **段を飛ばさない**: 意味の段のトークン・基礎・部品・パターン・文言は `D` だけを、`D` は `P` だけを指す。

### チェック（check の一部）

| 決まり | 落とすもの | 重さ |
| :- | :- | :- |
| `trace-missing` | 実在しない ID を指している | 違反 |
| `trace-none` | デザインの原則・基礎の節・意味の段のトークン・部品・パターンの節・文言の節に、根拠がない | 違反 |
| `trace-layer` | 段を飛ばしている（例: トークンが `P1` を指す） | 違反 |
| `trace-deprecated` | `## 廃止` の原則や、`$deprecated` のトークン、`status: deprecated` の部品を、ほかの決まりが使っている | 警告 |
| `trace-orphan` | どこからも使われない原則 | 警告 |

ここでの「違反」はデザインシステムの中の不備なので、アプリのコードの違反とは分けて出す（終了コードの扱いは 14節）。

### 影響の一覧

`update` で上の段を変えるとき、変えるものから下へたどって、影響を受けるものを一覧にする（`cli.mjs trace --from P1` で、P1 → D → トークン・部品・パターン・文言 → 出力のファイル）。部品から出力のファイルへは、部品の名前から決まりでたどる（SwiftUI は `<code>/Components/<outputs.swiftui の名前>.swift`、Expo は `<code>/components/<outputs.expo の名前>.tsx`、HTML は `design-system/html/components/<name>.html`）。人はこの一覧を見て、どこまで直すかを決める。

## 6. 全体の流れ

```text
/product-design:init        アプリごとに 1 回（途中で止めて、あとから続けられる）
  0. 準備: 対象のリポジトリ。design-system.json があれば、続きから始めるか update を勧める。
     なければ design-system.json を作り、stages をすべて pending にする
  1. アプリを調べる: 出すプラットフォームと出力（10節）、今のコード、今の文書（README、docs/）
  2. ① プロダクトの原則: あれば読む。なければ一問一答で作る → 承認
  3. ② デザインの原則: ① から下書きを作り、一問一答で決める → 承認
  4. 土台を選ぶ（4節）
  5. ③ 基礎とトークン: 今のコードと土台から下書き → 一問一答 → 承認
  6. ④ 部品・パターン・文言: ひな形と今のコードから下書き → 一問一答 → 承認。
     README.md・CHANGELOG.md もここで作る
  7. ⑤ 出力: 今の画面のスクリーンショットを撮っておく（書き換えの前）。
     check.mjs・shoot.mjs を写し、選んだ出力ごとにひな形を置いて仕様とトークンに合わせて直す。
     今の画面も部品とトークンで書き換える
  8. 確かめる: check --strict（根拠と出力のチェック）、ビルドと全テスト、
     カタログのスクリーンショット（ライト／ダーク、書き換えの前後）
  9. スクリーンショットを見せて承認（直したいところだけ対話で直す → 8 へ）
  10. コミットする。Claude の Design System に写す（--local なら写さない）

/product-design:update <変えたいこと | 候補 | Claude Design の案の URL>
  1. 何を変えるかを判断し、どの段の変更かを決める（候補なら 12節の流れ）
  2. 影響の一覧を出す（5節）
  3. 一問一答で変え方を決める → その段を直す → 影響を受ける下の段を順に直す
  4. 変更でチェックに合わなくなったアプリのコードも直す
  5. 確かめる（check --strict、ビルドと全テスト、変わった前後のスクリーンショット）→ 承認
  6. 版を上げて CHANGELOG.md を書き、コミットする。Claude の Design System に写す

/product-design:check
  根拠のつながり、トークンの検証、出力ごとのコードのチェック、未決の候補、
  古くなったもの（生成したコード、写した check.mjs と shoot.mjs、Design System）を一覧にする。直さない
```

段ごとの進み具合は `design-system.json` の `stages` に書く（`pending`・`approved`）。init はこれを見て続きから始める。上の段を承認し直したら、その下の段は `pending` に戻し、影響の一覧（5節）を見ながら順に承認し直す。

## 7. 置き場所

対象アプリのリポジトリの中:

```text
docs/product/
  principles.md          ① プロダクトの原則（ほかの道具も読む）
docs/design-candidates/
  <名前>.md              足りないものの候補。1 候補 1 ファイル（使う側の誰でも書く。12節）
design-system/
  design-system.json     設定。使う側が最初に読む入口（14節）
  README.md              入口の文書。土台、原則の要約、トークンの使いどころ、部品の一覧、足りないときの決まり
  principles.md          ② デザインの原則
  foundations.md         ③ 基礎（色・文字・余白とレイアウト・角丸・影・動き・アイコン・アクセシビリティ）
  tokens.json            ③ トークン（DTCG 2025.10）
  components/*.md        ④ 部品の仕様（1 部品 1 ファイル）
  patterns.md            ④ 画面の型と使い分け
  copy.md                ④ 文言の決まり
  CHANGELOG.md           版ごとの変更
  check.mjs              機械のチェック（プラグインから写したもの。手で直さない）
  shoot.mjs              スクリーンショット（同上）
  html/                  ⑤ HTML の出力（tokens.css、components/、見本のページ）
  screenshots/           カタログのスクリーンショット（<出力>/<ページ>-light.png / -dark.png）
<アプリ>/DesignSystem/     ⑤ SwiftUI の出力（Tokens.swift、Components/、Catalog/）
<アプリ>/src/design-system/ ⑤ Expo の出力（tokens.ts、global.css、components/、catalog/）
```

- 候補を `design-system/` の外に置くのは、`design-system/**` が `protected_paths`（14節）に入っていて、使う側は機能を作るあいだそこを変えないため。候補だけは、使う側が機能を作りながら書き足せる必要がある。
- Expo の出力の置き場所は `outputs.expo.code` で変えられる。`design-system/` と重なる場所（Expo のアプリがリポジトリの直下にあるときの `design-system/` など）は、init が断る。

## 8. トークン `tokens.json`（DTCG 2025.10）

例（HIG を土台にしたとき）:

```json
{
  "primitive": {
    "color": {
      "$type": "color",
      "brand": {
        "light": { "$value": { "colorSpace": "srgb", "components": [0, 0.392, 0.824], "hex": "#0064d2" } },
        "dark": { "$value": { "colorSpace": "srgb", "components": [0.251, 0.612, 1], "hex": "#409cff" } }
      }
    },
    "space": {
      "$type": "dimension",
      "2": { "$value": { "value": 8, "unit": "px" } }
    }
  },
  "color": {
    "$type": "color",
    "tint": {
      "$value": "{primitive.color.brand.light}",
      "$description": "主なボタン、選ばれている状態、リンク",
      "$extensions": {
        "com.github.japan-da-man.product-design": {
          "from": ["D1"],
          "modes": { "dark": "{primitive.color.brand.dark}" },
          "swiftui": { "system": "accentColor" }
        }
      }
    }
  },
  "space": {
    "$type": "dimension",
    "$extensions": { "com.github.japan-da-man.product-design": { "from": ["D2"] } },
    "2": { "$value": "{primitive.space.2}" }
  }
}
```

- **2 段**: 基本の段は最上位の `primitive` グループの下に、生の値で置く。意味の段（役割の名前）は、それ以外の最上位のグループ（`color`・`font`・`space`・`radius`・`shadow`・`duration`・`easing`）に置く。段はこの置き場所だけで見分ける。部品の段は、部品ごとに色を変える必要が出たら足す。アプリのコードとチェックが許すのは意味の段だけ。
- **基本の段の値**: shadcn/ui のときは Tailwind のスケールに合わせる（色は 50〜950 の段）。HIG のときは、色は HIG のシステムの色の値と、独自の色（ブランドの色など）を、ライトとダークの組で持つ。余白はどちらも 4px 刻み（HIG には余白の刻みがない）。
- **意味の段の必ずある役割**（ひな形の部品が使う）:

  | | HIG | shadcn/ui ＋ Tailwind |
  | :- | :- | :- |
  | 色（土台の名前） | `tint`・`label`・`secondary-label`・`tertiary-label`・`placeholder-text`・`separator`・`fill`・`secondary-fill`・`system-background`・`secondary-system-background`・`system-grouped-background`・`secondary-system-grouped-background` | `background`/`foreground`・`card`/`card-foreground`・`popover`/`popover-foreground`・`primary`/`primary-foreground`・`secondary`/`secondary-foreground`・`muted`/`muted-foreground`・`accent`/`accent-foreground`・`destructive`・`border`・`input`・`ring` |
  | 色（独自に足すもの） | `on-tint`（塗りの上の文字）・`destructive`・`warning`・`success`・`info` | `success`/…・`warning`/…・`info`/… |
  | 文字 | Dynamic Type の 11 段（`large-title`・`title-1`・`title-2`・`title-3`・`headline`・`body`・`callout`・`subheadline`・`footnote`・`caption-1`・`caption-2`） | 18節の未解決の点 |
  | 余白・角丸 | `space.1`〜`space.8`、`radius.sm`・`radius.md`・`radius.lg` | 同じ（角丸は shadcn/ui の `radius` から作る） |
  | 影・動き | `shadow.sm`・`shadow.md`、`duration.fast`・`duration.normal`、`easing.standard` | 同じ |

  shadcn/ui の `destructive-foreground` は、Tailwind v4 版の shadcn/ui の初期の CSS から外れているはずなので入れない。1 段階目に、今の shadcn/ui の名前と突き合わせる（18節）。
- **文字のトークン**: DTCG の `typography` の合成型に、`$extensions` の `textStyle`（Dynamic Type の段の名前）を必ず付ける。SwiftUI は、独自のフォントや大きさでも `relativeTo:` でこの段に合わせ、OS の文字の大きさの設定についていく（v1 の `textStyle` と同じ役目）。shadcn/ui の土台でも、iOS の出力のために付ける。
- **ダークモード**: ダークの値は `$extensions` の `modes` に書く。中の別名も、下の値の検証（参照先が実在する、循環しない）の対象にする。DTCG の一般の道具は `$extensions` の中の別名を解決しないので、ほかの道具に渡すとダークの値は失われる（18節）。
- **SwiftUI のシステムの色**: `$extensions` の `swiftui.system` に名前を書くと、`Tokens.swift` はシステムの色をそのまま使い、OS の切り替えを活かす。書ける名前は UIKit の意味の色の名前（`label`・`secondaryLabel`・`separator`・`systemFill`・`systemBackground`…。`Color(uiColor:)` で包む）と `accentColor` だけ。
  - `accentColor` 以外を書いたら、`$value` と `modes.dark` は HIG のその色の値の写しでなければならない（check が HIG の値の表と比べる）。HTML と Expo はこの値を使うので、プラットフォームの間で色がずれない。
  - そのため、`accentColor` 以外を付けた役割は濃くできない。下のコントラストの検証の組に前景として入れてよいのは、HIG の値のままで基準に届く役割（`label`。白の上で 21:1）だけ。HIG の値では届かない役割（白の上の `secondaryLabel` が約 3.4:1、白の文字を systemBlue に載せると 4.02:1）には付けず、独自の値を持たせる。`label` に付けたままにしておけば、OS のコントラストを上げる設定についていく。HIG のひな形の役割ごとの扱いは次の表のとおり。

    | 役割 | `swiftui.system` | コントラストの組 |
    | :- | :- | :- |
    | `label` | `label` | `system-background`・`secondary-system-grouped-background` の上で 4.5:1 |
    | `secondary-label` | 付けない。独自の値（v1 と同じく HIG より濃い。ライト `#6c6c70`・ダーク `#aeaeb2`） | 同じ |
    | `tertiary-label`・`placeholder-text` | 付ける | 入れない。本文に使わないことを `foundations.md` に書く |
    | `tint` | `accentColor`（値は自由。ひな形は白の上で 5.59:1 の `#0064d2`、ダークは黒の上で 7.42:1 の `#409cff`） | 背景の上で 4.5:1（リンク）、`on-tint` を載せて 4.5:1 |
    | `on-tint` | 付けない（ライトは白、ダークは黒） | `tint` の上で 4.5:1 |
    | `destructive`・`warning`・`success`・`info` | 付けない。独自の値 | 背景の上で 4.5:1。v1 の `success`（`#248a3d`）は白の上で 4.40:1 なので濃くする |
    | `separator`・`fill`・`secondary-fill`・背景の 4 つ | 付ける | 背景の側としてだけ使う。前景の組には入れない |
  - `accentColor` は、`$value` と `modes.dark` からアセットの AccentColor を作り、`Color.accentColor` で使う。
  - 書かなければ値から作る。
- 役割は足してよい（名前は小文字の kebab-case）。足したものも各出力に生成される。
- **値の検証**:
  - DTCG の形（`$value` が必須、参照先が実在する、循環しない）。
  - 必ずある役割の欠け。
  - コントラスト比。調べる組（前景 → 背景）は、ひな形のトークンの最上位の `$extensions` に `contrast` として持たせる（例: `foreground`→`background`、`muted-foreground`→`muted`、`muted-foreground`→`background`、`label`→`system-background`）。
  - 透明度のある色は、背景に合成してから計算する。
  - 文字は 4.5:1 未満が違反（大きい文字に使う組は 3:1）。文字でない UI（`ring`・`input` の枠、1.4.11）は 3:1 未満を警告にする。
  - ひな形の値がこの検証を通ることをテストにする。たとえば shadcn/ui の初期の `muted-foreground` は、`muted` の上で 4.5:1 に届かないので濃くする。HIG のひな形で組に入れる役割は、上の表のとおり。
  - `swiftui.system`（`accentColor` 以外）を付けた役割の組が基準に届かないときは、ほかの組と同じく違反にする。そのうえで、値を濃くするには `swiftui.system` を外して独自の値にする必要がある、と案内する（付けたままでは値を変えられないため）。基準に届く組は、付けたままでよい。

## 9. 部品の仕様 `components/*.md`

プラットフォームに依らない形で書き、各出力はこれを実装する。

```markdown
---
name: button
status: stable          # draft・stable・deprecated
from: [D1, D3]
outputs: { swiftui: DSButton, expo: Button, html: button }
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
| トークンの生成 | `tokens.css`（CSS 変数。色は hex。ダークは `prefers-color-scheme` と `data-theme`） | `Tokens.swift`（`DS.Color`・`DS.Font`・`DS.Space`・`DS.Radius`・`DS.Shadow`・`DS.Motion`。色は sRGB） | `tokens.ts`、`global.css`（NativeWind の CSS 変数）、`tailwind.config.js` |
| 部品 | HTML と CSS（ビルドなし）。独自の `ds-*` のクラスと手書きの CSS で作り、Tailwind のユーティリティのクラスは使わない。shadcn/ui を土台にするなら要素・属性・見た目を shadcn/ui に合わせ、HIG なら iOS の見た目をまねる | SwiftUI の標準の部品を包む（今の design-system のひな形） | React Native Reusables を土台にする |
| カタログ | 部品ごとの見本のページ（Claude の Design System に写す） | `#if DEBUG` のカタログ画面（起動引数 `-DesignSystemCatalog <ページ>`。今のファイルの名前と形を保つ。16節） | 開発のときだけ開くカタログの画面（開き方は 4 段階目に決める） |
| コードのチェック | なし（生成物なので） | 今の `check.mjs` の Swift の決まり（`color`・`font`・`spacing`・`control`） | TSX の直書きの色・文字・余白と、部品を通さない `Pressable`・`TextInput` など |
| スクリーンショット | 手元の Chrome を `--headless --screenshot` で呼ぶ（ダークは `data-theme`）。Chrome がなければ撮らずに知らせる | シミュレーターで撮る（今の `shoot.mjs`） | シミュレーターで撮る |

- **選び方**:
  - 探すのはリポジトリの直下と、その 1 つ下（`apps/*`・`packages/*` など）。
  - 先に Expo を見る（prebuild した Expo のアプリには `ios/*.xcodeproj` もあるため）。`package.json` に `expo` がある → Expo。
  - `*.xcodeproj`・`project.yml`・`Project.swift`（Tuist）・アプリを作る `Package.swift` がある → SwiftUI。xcodeproj 以外で見つけたときは、合っているか聞く。
  - `react-native` はあるが `expo` がない、SwiftUI と Expo の両方がある、どちらもない → 聞く。両方あれば、両方を出力にしてよい。
  - 選んだ出力は `design-system.json` の `outputs` に書き、あとから update で足したり変えたりできる。
- **名前の作り方**: トークンの道のりから、各出力の名前を決まりで作る。
  - SwiftUI: 最上位のグループが型（`color` → `DS.Color`、`font` → `DS.Font`、`duration` と `easing` → `DS.Motion`）、残りを camelCase にする（`color.secondary-label` → `DS.Color.secondaryLabel`、`font.title-1` → `DS.Font.title1`）。`space` と `radius` は、v1 と同じくグループの名前を前に付ける（`space.2` → `DS.Space.space2`、`radius.md` → `DS.Radius.radiusMd`）。
  - Dynamic Type の段は SwiftUI の名前に対応させる（`title-1` → `.title`、`caption-1` → `.caption`、`title-2` → `.title2` など）。
  - CSS と NativeWind: 意味の段の名前をそのまま CSS 変数にする（`--secondary-label`、`--muted-foreground`）。
- **色空間**: トークンは sRGB で持つ（`components` と `hex`）。shadcn/ui の初期値は OKLCH なので、ひな形を作るときに sRGB に変換し、色域の外は丸める。NativeWind の版と、`global.css` の色の書き方（hex か HSL の成分か）は、4 段階目に版を決めて書く（18節）。
- **HTML とアプリ用のずれ**: 同じ部品の HTML 版とアプリ用の版のスクリーンショットを、カタログのページごとに並べて見せ、承認のときに見比べる。
- **Expo の部品を Web に描いて HTML の見本に使う**（react-native-web）ことができれば、Expo では部品の実装が 1 つで済む。できるかは 4 段階目で確かめる（17節・18節）。
- **シミュレーターの使用中の印**: この Mac ではシミュレーターを 1 台ずつしか使えない。そこで、撮影の前に印を確かめ、使用中なら撮らずに知らせる。対象は iOS のシミュレーターだけ（Android のエミュレーターは対象外）。
  - 共通の印は `~/Library/Caches/com.github.japan-da-man/simulator.lock`。中身は pid と起動の時刻（pid の使い回しに備える）。
  - 撮るあいだは、自分も排他的に作って（`wx`）置き、終わったら消す。ほかの道具にも同じ印を使ってもらう。
  - 移るあいだのために、`design-system.json` の `simulator.extra_locks` に、ほかの印のパスを足せる。足したパスも見るが、そこに印を置きはしない。
  - v1 の `shoot.mjs` は `~/.factory/line.lock` を見ていたので、`migrate` はこのパスを `extra_locks` に書く。使う側が共通の印に移ったら消す。

## 11. Claude の Design System への写し

- 正はリポジトリ。init と update の最後に、Claude の Design System（Artifact の型）へ **一方向で** 写す（ページ上の編集は止める）。単独の Claude Design（claude.ai/design）は 2026-12-14 までに閉じて Claude の中に移るので、写し先は Claude の Design System にする。
- 写すもの:
  - トークン。`artifact-stage` が DTCG から Design System の受け付ける形（名前・値・使いどころ、ライトとダーク）に変える。v1 は Design System と同じ形で持っていたのでそのまま写せたが、v2 では変換が要る。受け付ける形は 2 段階目に確かめる。
  - 文書（README・principles・foundations・components・patterns・copy）。
  - HTML の部品と見本のページ、アプリ用の出力のスクリーンショット、表紙。
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
  └─ 3. 候補として記録する（docs/design-candidates/ か、案の下の「部品の候補」）
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
- **候補の戻し方**: Claude Design の中の Design System は一方向の写しなので、Claude Design からは書き戻せない。`update` に Claude Design の案（Artifact の URL か HTML）を渡すと、案の下の「部品の候補」を拾って `docs/design-candidates/` に足す。ほかの道具は `docs/design-candidates/` に直接書く。
- **候補のファイル `docs/design-candidates/<名前>.md`**: 1 候補 1 ファイル（並行して作業する worktree どうしで衝突しにくい）。先頭のメタデータに `status`（`open`・`adopted`・`exception`・`rejected`）と `screens`（どの画面で必要か。一覧）を持ち、本文に、何のために、何が足りないか、仮の形（どの部品とトークンで組んだか）、決めた日と理由を書く。
  - 使う側は、新しい候補のファイルを足すか、すでにある候補の `screens` に画面を書き足すだけにする。`status` を変えるのは update だけ。
  - 書く前に、すでにある候補を見て、同じものなら書き足す。update は、名前や中身が似た候補をまとめて見せ、1 つにまとめるか聞く。
  - 「2 つ以上の画面」は `screens` の数で数える。
- **実装の前の決着**: check は、`open` の候補の数を `--json` の `candidates` に出す。終了コードには効かせない。実装の前にこれが 0 件であることを確かめるのは、使う側の役目。

## 13. 運用

- **版**: `design-system.json` の `ds_version`（semver）。
  - メジャー: 役割や部品を消す・名前を変える、土台を変える（アプリのコードが壊れる）
  - マイナー: 役割・部品・種類・パターンを足す、原則を変える
  - パッチ: 値の調整、文書の直し
  - 1 回の update に複数の種類が混ざったら、いちばん大きいものに合わせる（原則を変えて役割が消えるなら、メジャー）。
- **変更履歴**: update のたびに `CHANGELOG.md` に、版、日付、変えたこと、根拠（どの ID）、影響を受けたファイルを書く。
- **廃止**:
  - トークンは DTCG の `$deprecated`（理由と置き換え先の文字列）、部品は `status: deprecated` と置き換え先、原則は `## 廃止`（5節）。
  - check は、廃止されたものを使うコードや決まりを `deprecated` と `warnings` に出す（警告。違反にはしない）。
  - 次のメジャー版で消す。

## 14. 設定 `design-system/design-system.json`（v2）

使う側が最初に読む入口。

```json
{
  "version": 2,
  "ds_version": "1.0.0",
  "base": "hig",
  "stages": { "product": "approved", "design": "approved", "foundations": "approved", "components": "approved", "outputs": "approved" },
  "product_principles": "docs/product/principles.md",
  "docs": ["design-system/README.md", "design-system/principles.md", "design-system/foundations.md", "design-system/patterns.md", "design-system/copy.md"],
  "components": "design-system/components",
  "tokens": "design-system/tokens.json",
  "candidates": "docs/design-candidates",
  "outputs": {
    "html": { "code": "design-system/html" },
    "swiftui": {
      "project": "FactorySample.xcodeproj", "scheme": "FactorySample", "bundle_id": "com.japandaman.FactorySample",
      "device": "iPhone 17", "code": "FactorySample/DesignSystem", "sources": ["FactorySample"],
      "catalog_pages": ["buttons", "inputs", "messages"]
    },
    "expo": { "code": "src/design-system", "sources": ["src", "app"] }
  },
  "protected_paths": ["design-system/**", "docs/product/principles.md", "FactorySample/DesignSystem/**"],
  "check": { "command": "node design-system/check.mjs", "exclude": [] },
  "simulator": { "extra_locks": [] },
  "artifact": { "url": "https://claude.ai/artifact/…", "hash": "…" },
  "platform": "ios",
  "ios": {
    "project": "FactorySample.xcodeproj", "scheme": "FactorySample", "bundle_id": "com.japandaman.FactorySample",
    "device": "iPhone 17", "code": "FactorySample/DesignSystem", "sources": ["FactorySample"],
    "catalog_pages": ["buttons", "inputs", "messages"]
  }
}
```

- `docs`: ファイルだけを並べる（使う側がそのまま読めるように）。部品の仕様のフォルダは `components` に分ける。
- `protected_paths`: このプラグインが持つファイル。使う側は、機能を作るときにここを変えない（変えるのは update だけ）。候補の `docs/design-candidates/` は入れない（12節）。
- `check.command`: 使う側が実行するコマンド。
  - **終了コード 1 になるのは、アプリのコード（各出力の `sources`）の違反だけ**。機能を作る人が直せるものに限る。
  - デザインシステムの中の不備（トークンの検証、`trace-*` の違反）・古くなったもの・未決の候補は、`--json` の欄に出すだけで、終了コードには効かせない。
  - `--strict` を付けると、デザインシステムの中の不備でも 1 になる（init と update の確かめに使う）。
  - `--json` の形: `{ ok, violations, ds_errors, warnings, stale, deprecated, candidates, allowed }`。
- `check.exclude`: v1 と同じく、チェックから外すファイル。
- 許可のコメントの書き方 `// design-system: allow <決まり>` は v1 から変えない（今のアプリのコメントが効き続けるように）。
- `platform` と `ios`: v1 を読む道具のために残す。`outputs.swiftui` があるあいだ、update は `outputs.swiftui` を書き換えるたびに、同じ値で `ios` を書き直す（正は `outputs.swiftui`）。

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
    tokens/hig.json            土台ごとの最初のトークン（コントラストを調べる組を含む）
    tokens/shadcn.json
    components/                部品の仕様のひな形
    html/ swiftui/ expo/       出力ごとの部品とカタログのひな形
  tests/                       node --test
```

## 16. 今の design-system からの移行

### プラグイン

- `plugins/product-design/` を新しく作る。`plugins/design-system/` は、v1 からの移行（3 段階目）と、使う側の対応が済むまで残し、そのあとで消す。それまでのあいだ、init 済みのアプリは今のプラグインで update できる。
- 直す登録:
  - `.claude-plugin/marketplace.json`: `product-design` を足す。`design-system` は消すときに外す。
  - `plugins/japan-da-man-mods/.claude-plugin/plugin.json`: `dependencies` の `design-system` を `product-design` に替える。
  - `README.md`: プラグインの一覧。
- **古いプラグインに、v2 のアプリを書き換えさせない**。古いプラグインの `cli.mjs install` は、設定の版を見ずに `check.mjs`・`shoot.mjs` を v1 のもので上書きし、ない部品のひな形も置き直す（`plugins/design-system/scripts/cli.mjs:56`）。v2 に移したアプリでこれが動くと、v1 の check は DTCG の `tokens.json` を読めずに終了コード 1 を返し、check を実行するゲートがすべての機能で落ちる。使う側は、古いプラグインを残すあいだも `/design-system:update` を案内しうる。そこで、product-design の 1 段階目と一緒に、古いプラグインの版を 1 つ出す。
  - `cli.mjs` は、`design-system.json` の `version` が 2 以上なら、`install`・`tokens`・`status`・`screenshot`・`artifact-*` を断り、`/product-design:*` を案内して終了コード 2 で終わる。
  - `skills/init`・`skills/update`・`skills/check` も、最初の手順で同じことを確かめて止まる。
  - テストに「v2 の設定では何も書き換えない」を足す。
- 古いほうを消す前に、`design-system` の説明を「`product-design` に移った」に変えた版を 1 つ出す（すでに入れている人が、何に替えればよいかわかるように）。

### 特定の使う側への言及をなくす

スキル・スクリプト・ひな形の中にある factory への言及（テストを除いて 22 か所。`tests/shoot.test.mjs` の 6 か所も直す）を、どの道具にも通じる言葉に直す。

- `shoot.mjs` の、factory のラインが動いているかを見る処理 → 共通のシミュレーターの使用中の印と `extra_locks`（10節）
- 「部品の候補」を PR のレポートから受け取る流れ → `docs/design-candidates/`（12節）
- 文書のひな形の「factory の実装役は従う」など → 「画面を作る人と道具は従う」

### 使う側で壊れるもの

使う側の対応は、それぞれの道具の側の PR で行う（このプラグインの PR には入れない）。ただし、v2 の設定に v1 の項目を残すだけでは、次のものが壊れる。古いプラグインを消すのは、これらが直ってからにする。

| 使う側の場所 | 壊れること | 直し方 |
| :- | :- | :- |
| `plugins/factory/agents/ui-mocker.md:22` | `design-system/components.md` を名前で読むが、v2 では `components/*.md` に分かれる | `design-system.json` の `docs` と `components` を読む |
| `plugins/factory/line/mock.js:18`・`:43`、`line/line.js:169`、`skills/init/SKILL.md:34`、`skills/start/SKILL.md:69`、`DESIGN.md:416-425` | `/design-system:init`・`/design-system:update` という、なくなるコマンドを案内する | `/product-design:*` に替える |
| `plugins/factory/line/design.js`（`parseComponentCandidates`） | 「部品の候補」を PR のレポートの節から拾う | `docs/design-candidates/` にファイルを書く |
| `plugins/factory/line/line.js:264` | `protected_paths` をそのまま禁止ファイルにする | 変えなくてよい（候補を `design-system/` の外に置いたため） |
| `plugins/factory/line/line.js:432`・`:513` | `check.command` が 0 以外ならその周を落とす | 変えなくてよい（デザインシステムの中の不備では 1 にしないため。14節） |
| `plugins/factory/line/queue.js`（`line.lock`） | 共通のシミュレーターの印を置かない | ラインが動くあいだ、共通の印も置く。置くようになったら、アプリの `extra_locks` から `~/.factory/line.lock` を外す |
| `plugins/factory/line/mock.js:19-20`・`:30`、`ui-mocker.md:17`・`:28` | `ios.code`・`ios.sources` と、カタログのファイル（`Catalog/DesignSystemCatalog.swift`）と `content(for:)` の形に頼る | 変えなくてよい（`ios` を残し、SwiftUI の出力はカタログのファイルの名前と形を保つ） |

### init 済みのアプリ（v1）

`update` が v1 を見つけたら、移行を提案する（`cli.mjs migrate`）。v1 のアプリは SwiftUI なので、土台は HIG にする。

- 今の `tokens.json` を DTCG の意味の段に移す（基本の段は値から作る）。
- 文書を ②〜④ の形に分ける。① と ② は一問一答で作る（v1 の README の「原則」を下書きにする）。
- `simulator.extra_locks` に `~/.factory/line.lock` を書く（10節）。
- スクリーンショットは `screenshots/swiftui/` に移し、Artifact のハッシュは移したあとの置き場所で計算し直す。
- **名前の対応**: v1 の役割の名前は v2 の名前に移す。古い名前は、`$deprecated`（置き換え先つき）の別名のトークンとして `tokens.json` に残す。`Tokens.swift` は古い名前を `@available(*, deprecated, renamed:)` の別名として作る。こうすれば、今の部品とアプリの画面はそのままビルドでき、check は古い名前を使う箇所を `deprecated` に出す。アプリのコードを新しい名前に書き換えるかは update で聞き、古い名前は次のメジャー版で消す。

  | v1 | v2（HIG） |
  | :- | :- |
  | `accent` | `tint` |
  | `textPrimary` | `label` |
  | `textSecondary` | `secondary-label` |
  | `textOnAccent` | `on-tint` |
  | `danger` | `destructive` |
  | `background`（`#f2f2f7`/`#000000`） | `system-grouped-background` |
  | `surface`（`#ffffff`/`#1c1c1e`） | `secondary-system-grouped-background` |
  | `border`（`#c6c6c8`/`#38383a`、不透明） | `separator` |
  | `success`・`warning`・`info` | 同じ |
  | `DS.Font.*`（`title`・`headline`・`body`・`callout`・`caption`） | v1 の `textStyle` が指す Dynamic Type の段 |
  | `space-1`〜`space-6`、`radius-sm`・`radius-md`・`radius-lg` | `space.1`〜、`radius.sm`〜（Swift の名前は `DS.Space.space1`・`DS.Radius.radiusMd` のまま。10節） |

  - 移す先は名前ではなく値で決める。v1 の `background`・`surface` の値は HIG の grouped の背景の組なので、`system-background`・`secondary-system-background` には移さない（移すと、あとで HIG の値に揃えたときに、ライトで背景とカードの明暗が逆になる）。
  - 値は v1 のまま持ち越し、`swiftui.system` は付けない（見た目を変えない）。HIG の値に揃えるかは、update で役割ごとに聞く。`border` は不透明の値なので、揃えるなら `separator`（半透明）ではなく `opaqueSeparator` を書く。
- 部品の種類の名前も同じ扱いにする。たとえば `DSButton.Kind` の `primary`・`secondary` は、HIG のスタイルの名前（`filled`・`tinted` など）の、廃止の別名として残す。

## 17. 作る順番

1. **土台**: `plugins/product-design/` を作る（古いプラグインは残し、v2 のアプリを断る版を同時に出す。16節）。①〜④ の段（ひな形と一問一答）、DTCG のトークンと検証、根拠のチェックと影響の一覧（5節）、候補のファイル、版と CHANGELOG。プラットフォームに依らない部分。shadcn/ui の名前の突き合わせと、文字の段の決定（18節）もここで行う。
2. **HTML の出力**と、Claude の Design System への写し（いつも要るので先に作る）。Design System が受け付けるトークンの形を確かめる。
3. **SwiftUI の出力**を今のものから作り直し、v1 からの移行を作る。使う側（16節の表）の対応が済んだら、古いプラグインを消す。
4. **Expo の出力**（`tokens.ts`・`global.css`・`tailwind.config.js`・React Native Reusables を土台にした部品・カタログ・TSX のチェック）。NativeWind の版とカタログの開き方を決め、react-native-web で部品を HTML の見本に使えるかを確かめる。

3 と 4 は、次に作るアプリが SwiftUI か Expo かで、先にやるほうを入れ替えてよい。

## 18. リスクと未解決の点

- **shadcn/ui を土台にするときの文字の段**。shadcn/ui には文字の段がない。HIG の Dynamic Type の名前（iOS が中心のアプリ）と、Material 3 の文字の段（Android も同じくらい大事なアプリ）のどちらにするかを、1 段階目で決める。
- **shadcn/ui の今の名前**。`destructive-foreground` が Tailwind v4 版で外れたことなど、8節の表は記憶に基づく。1 段階目に、今の shadcn/ui の CSS と突き合わせる。
- **DTCG のテーマ**。DTCG 2025.10 の Format の仕様はテーマの切り替えを持たない。テーマを扱う Resolver の仕様が、2025.10 と一緒に安定版として出ているかもしれない（要確認）。最初の版は、作りが簡単な `$extensions` の `modes` で始める。1 段階目に Resolver の状態と道具の対応を確かめ、使えるなら移す。`modes` のままだと、ほかの DTCG の道具はダークの値を読まない。
- **NativeWind と色の書き方**。今の shadcn/ui は Tailwind v4 と OKLCH を使うが、NativeWind v4 は Tailwind v3 系で、React Native が `oklch()` を解釈できるかもわからない。だからトークンは sRGB で持ち、出力ごとに書き方を変える（10節）。NativeWind の版は 4 段階目に決める。
- **Design System のトークンの形**。v2 で DTCG に変えたので、写すときに変換が要る。Design System が受け付ける形は、2 段階目に確かめる。
- **HIG の値の写し**。HTML の出力で iOS をまねるとき、システムの色の値は HIG に載っている値を書き写すので、OS の版で値が変わるとずれる。SwiftUI の出力はシステムの色をそのまま使うので、ずれは HTML の側にだけ出る。
- **HTML とアプリ用の部品のずれ**。同じ仕様から別々に実装するので、ずれは残る。スクリーンショットを並べて見比べることで補う。Expo では react-native-web で 1 つにできるかもしれない（4 段階目で確かめる）。
- **SF Pro**。ライセンスが Apple の OS 向けのソフトの画面の案を作る用途に限られるので、HTML の出力では Web フォントとして埋め込まず、`system-ui` を指定する。
- **根拠のチェックは形だけを見る**。ID がつながっているかは確かめられるが、その根拠が本当に筋が通っているかは確かめられない。そこは各段の承認で人が見る。
- **原則の質**。「使いやすく」のような、判断に使えない原則になりやすい。一問一答では「A より B」の形と「だから、こうする」を必ず書かせ、どちらを選ぶかで答えが変わらない原則は書き直してもらう。
- 今の design-system から引き継ぐもの:
  - チェックは正規表現でコードを見るので、見逃しや誤検知がある（`allow` のコメントで逃がす）。
  - カタログは部品を並べた画面なので、組み合わせた見た目までは保証しない。
