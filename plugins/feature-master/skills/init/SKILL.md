---
name: init
description: プロダクトの機能マスタ（機能ごとの設計意図）を最初に作る。今のコードやドキュメントから機能をユースケース単位で洗い出し、区切り方と全体の前提を確かめてから、全機能の機能名・概要・Actor・利用シーン・関連機能・大事にしていること・前提・想定していないことを下書きし、選んだ機能だけ一問一答で確かめて、docs/features/ に 1 機能 1 ファイルで置く。「機能マスタを作って」「/feature-master:init」と言われたときに使う。プロダクトごとに 1 回。
model: opus
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *) Bash(git fetch *) Bash(git status*) Bash(git rev-parse *) Bash(git log *) Bash(git diff*) Bash(git add *) Bash(git commit *)
---

# feature-master:init: 機能マスタを作る

引数: $ARGUMENTS

機能マスタは、**この機能はどんな利用シーンを想定して作ったか** を残すもの。あとで機能を付け足すときや、新しい機能を考えるときに、既存の機能との兼ね合いを確かめるために読む。実装の記録（画面・データ・コード・テスト）ではない。形式と項目の意味は `${CLAUDE_PLUGIN_ROOT}/DESIGN.md`。

0. 準備 → 1. プロダクトを知る → 2. 一覧の下書き → 3. 一覧を確かめる → 4. 全部を下書きで書く → 5. 選んで確かめる → 6. 案内を足す → 7. 承認とコミット、の順に進める。

質問は必ず **AskUserQuestion** で出す。本文に質問を並べない。1 回に出すのは、答えが前の答えに依存しない質問だけ（最大 4 問）。選択肢をつけ、おすすめは先頭にして「(Recommended)」を付ける。**調べれば分かること（どんな機能があるか、何ができるか）は質問せず、自分で調べる。**

機能が数十あると、機能ごとに意図を聞くのは重すぎる（試したときは 2 機能目で打ち切りになった）。だから **全機能の意図をまず推測で書き（下書き）、人が確かめるのは選んだ機能だけ** にする。確かめなかった機能は `draft: true` のまま残り、あとで直せる。

## 0. 準備

- 対象のリポジトリを決める。`git rev-parse --show-toplevel` を使い、引数にパスがあればそちらにする。以降のコマンドはそのパスで実行する（`cd <repo> && …`）。
- `docs/features/` に `actors.md`・`product.md` か機能ファイルがすでにあれば、作り直さずに終える。機能ファイルを直接直し、`/feature-master:check` で確かめるよう伝える。
- `git fetch -q origin` のあと `git status -sb` を見る（origin がなければ fetch は飛ばす）。origin より遅れていたら pull してよいか尋ねる。まだコミットしていない変更があれば、それを伝えて続けてよいか尋ねる（7 でコミットするのは機能マスタと案内のファイルだけにする）。

## 1. プロダクトを知る

次を読み、プロダクトが **誰の、どんな用事のためにあるか** と、**利用者から見てできること** をつかむ。

- README・`docs/`（`docs/specs/` があれば、機能ごとの仕様と、そこに書かれた要望の背景。ADR があれば、何をなぜ見送ったか）・CLAUDE.md・AGENTS.md
- コード: 画面とその遷移、ルーティング、CLI のコマンド、公開している API、バックグラウンドの処理（通知、同期、定期実行など）
- `git log --oneline -50` で、機能が足された順と、その言い方

リポジトリが大きければ、観点ごと（画面、API、バックグラウンドの処理など）に Explore のサブエージェントに分けて調べさせてよい。返してもらうのは「利用者から見てできること」の一覧と、根拠のファイル:行だけにする。

コードがない（これから作るプロダクトの）ときは、ここは飛ばし、2 の下書きを作らずに、3 で機能の一覧をインタビューで作る。

## 2. 一覧の下書き

次を下書きにする（まだファイルには書かない）。

- **Actor**: 機能を使う人や仕組み。人の役割（利用者、管理者、ゲストなど）と、人の操作なしに動くもの（`system`: 通知を出す、同期する、など）。ID は小文字の kebab-case の英語。
- **全体の前提**: すべての機能に当てはまる、想定している使われ方の条件（使う人、端末、通信、言語など）の候補。
- **機能の一覧**: ユースケース単位。**Actor がやりたいこと 1 つを 1 機能** にする（「タスクを追加する」「タスクを完了にする」）。画面単位にしない（1 つの画面に複数の機能があっても、1 つの機能が複数の画面にまたがってもよい）。機能ごとに `id`（小文字の kebab-case の英語）、機能名（「〜する」の形。利用者の言葉で）、Actor、1 文の概要。

## 3. 一覧を確かめる

Actor と機能の一覧を表（id・機能名・Actor・概要）で見せてから、AskUserQuestion で次を聞く。

1. 機能の区切り方は合っているか（このまま／まとめたい機能がある／分けたい機能がある／抜けている機能がある）。直したいと答えたら、どれをどうするか続けて聞き、一覧を直して見せ直す。
2. Actor は合っているか（このまま／足りない／分けたい・まとめたい）。
3. 全体の前提（multiSelect）。2 の候補を出す。選ばれたものだけを `product.md` に書く。
4. 今は作っていないが、作る予定の機能があるか。あれば `開発中` として一覧に足す。

## 4. 全部を下書きで書く

1. ひな形を置く:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs install <repo>
   ```

   `docs/features/` と、ひな形の `actors.md`・`product.md` ができる。`template` に出る機能ファイルのひな形（`feature.md`）を Read で読む。
2. `actors.md` の表に 3 で確かめた Actor を、`product.md` の `## 前提` に 3 で選ばれた全体の前提を、箇条書きで書く。
3. **全機能** の `docs/features/<id>.md` を、ひな形の形で書く。どれも `draft: true` を付ける（5 で確かめた機能だけ外す）。各項目は 1 で読んだコードとドキュメントから推測して書く。

   | 項目 | 書き方 |
   | :- | :- |
   | `status` | 動くコードがあれば `提供中`。作りかけ・フラグで隠れているもの・画面がまだないものは `開発中`、消す予定なら `廃止予定` |
   | `related` | 利用シーンの中でつながる機能と、そのつながり（`note`）。呼び出しやデータの依存ではなく、利用者の流れでつながるもの。双方にとって意味があるなら両方のファイルに書く。なければ `related:` の行ごと消す |
   | 概要 | 何ができるかを 1〜3 文で。画面の名前・クラス名・実装の細部は書かない |
   | 利用シーン | 「状況 → したいこと」の箇条書き |
   | 大事にしていること | **利用者から見た体験** を書く（良い例:「思いついてから数秒で登録できる」「店の中で片手のまま押し違えない」）。**コードから読める仕様のルールは書かない**（悪い例:「招待コードは 1 回だけ使え、期限がある」「数量は 1〜999」）。ルールの裏にある体験が分かるなら、そちらを書く（例:「招待した相手だけが参加でき、知らない人にリストを見られない」） |
   | 前提 | **この機能だけの** 前提。`product.md` の全体の前提は繰り返さない |
   | 想定していないこと | あえて対象にしていない使い方と、その理由。ドキュメント・ADR・コミットに見送った根拠があるものを優先する |

   - ひな形の `<…>` と `<!-- … -->` は残さない。
   - 根拠がなく推測できない項目は、作り話をせずに見出しごと消す（`概要` と `利用シーン` は必ず書く）。
4. 一覧を作り、確かめる:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs index <repo>
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs check <repo>
   ```

   `index` が `errors` を返したら、ファイルを直してやり直す（エラーがあるあいだは一覧を作らない）。`check` の `warnings` は、Actor の使われ方の警告以外は直す（`premise` の警告は、全体の前提を繰り返している行なので消す）。

## 5. 選んで確かめる

1. 下書きを短い表（機能名・利用シーンの 1 つ目・大事にしていること）で見せ、詳しくは `docs/features/` のファイルを開けば読めることを伝える。
2. AskUserQuestion（multiSelect）で、今すぐ意図を確かめる機能を聞く。選択肢は、中心になる機能（よく使われる、ほかの機能の起点になる）から 3 つまでと、「今は確かめない」。ほかの機能は「Other」に機能名を書いてもらう。
3. 選ばれた機能ごとに、1 回の AskUserQuestion で次の 4 問を出す。どの問も multiSelect で、選択肢の先頭は **下書きの内容**（「下書きのまま (Recommended)」として中身を説明に書く）、続けて別の候補。

   | 問 | 別の候補 |
   | :- | :- |
   | 利用シーン | 下書きにない「状況 → したいこと」 |
   | 大事にしていること | 下書きにない、守りたい体験の候補。「特にない」 |
   | 前提 | この機能だけの前提の候補。「特にない」 |
   | 想定していないこと | あえて対象にしていない使い方と、その理由の候補。「特にない」 |

   答えに合わせてファイルを直し、`draft: true` を消す。ユーザーが「Other」で書いた言葉は、意味を変えずに「状況 → したいこと」などの形に整える。答えが「下書きのまま」でなかった項目は、選ばれなかった候補を書かない。「残りは任せる」「ほかも同じでよい」のような答えなら、その項目は下書きのままにし、その機能の `draft: true` は残す。
4. 確かめ終えたら、4 の 4 の `index` と `check` をやり直す。

## 6. 案内を足す

ふだんのセッションで機能マスタが読まれるように、リポジトリの指示のファイルに案内の節を足す。足す先は次の順で決める。

1. `CLAUDE.md` があり、中身が `@AGENTS.md` の読み込みだけなら `AGENTS.md`
2. `CLAUDE.md` があれば `CLAUDE.md`
3. `AGENTS.md` があれば `AGENTS.md`
4. どちらもなければ、`CLAUDE.md` を作る

足す先と、足すかどうかを AskUserQuestion で尋ねる（足す（Recommended）／足さない）。すでに同じ内容の節があれば足さない。**足す先のファイルの言語に合わせて** 書く（日本語なら下、英語なら下の英語版）。

```markdown
## 機能マスタ

`docs/features/` に、機能ごとの設計意図（利用シーン・大事にしていること・前提・想定していないこと）がある。一覧と全体の前提は `docs/features/README.md`。

- 機能を付け足すとき、新しい機能を考えるとき、仕様を書くときは、関係する機能のファイルと `product.md` を先に読む。前提や想定していないことと食い違う、または大事にしていることを損なうおそれがあれば、進める前にユーザーに伝える。
- `draft: true` の機能は、意図をまだ人が確かめていない推測なので、根拠にするときはそう伝える。
- 機能を足したり、意図が変わったりしたら、機能ファイルも直し、`/feature-master:check` で確かめる。
```

```markdown
## Feature master

`docs/features/` records the design intent of each feature: its usage scenes, what the experience must preserve, its assumptions, and the uses it deliberately excludes. The index and the product-wide assumptions are in `docs/features/README.md`.

- Read the files for the related features and `product.md` before adding to a feature, designing a new one, or writing a specification. If a change would contradict an assumption or an excluded use, or risks breaking something the feature must preserve, raise it with the user before proceeding.
- A feature marked `draft: true` holds intent nobody has confirmed yet; say so when you rely on it.
- When a feature is added or its intent changes, update the feature file as well and verify it with `/feature-master:check`.
```

## 7. 承認とコミット

1. 一覧（`docs/features/README.md`）のパスと、確かめた機能・下書きのままの機能の数を伝え、AskUserQuestion で「この機能マスタで承認する／直したい機能がある」を聞く。直したい機能があれば、どれをどう直すか聞いて直し、4 の 4 からやり直す。
2. `git status` で変わったファイルを確かめ、`docs/features/` と 6 で直した案内のファイルだけをコミットする。メッセージはリポジトリの書き方に合わせる（例: `Add the feature master: intent of each feature`）。push はしない（push するかユーザーに尋ねる）。

## 終わりに

次を短く伝える。

- 作ったもの（Actor の数、全体の前提の数、機能の数、そのうち確かめた機能と下書きの機能の数）
- 下書きの機能は、ファイルを直接直して `draft: true` を消せば確かめたことになること
- 守られているかは `/feature-master:check` で確かめられること
