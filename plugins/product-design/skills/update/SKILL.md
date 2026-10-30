---
name: update
description: デザインシステムを変える（原則を変える、色・文字・余白などのトークン、部品の仕様、画面の型、文言の決まりを足す・変える、docs/design-candidates/ の候補や Claude Design の案の「部品の候補」を決める）。変えるものから下の段への影響を一覧にし、人が一問一答で決め、その段と影響を受ける下の段と HTML の出力を直し、版を上げて CHANGELOG を書き、Claude の Design System に写し直す。「デザインシステムに〇〇を足して」「原則を変えたい」「この候補を決めて」「/product-design:update <変えたいこと>」と言われたときに使う。
argument-hint: "<変えたいこと | 候補のファイル | Claude Design の案の URL> [--local]"
model: opus
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *) Bash(node *design-system/check.mjs*) Bash(git fetch *) Bash(git status*) Bash(git rev-parse *) Bash(git diff*) Bash(git add *) Bash(git commit *)
---

# product-design:update: デザインシステムを変える

変えたいこと: $ARGUMENTS

デザインシステムは人が決めるもの。ここで一問一答で決めてから変える。上の段を変えたら、影響を受ける下の段まで直す。設計は `${CLAUDE_PLUGIN_ROOT}/DESIGN.md`。

0. 準備 → 1. 今のデザインシステムを読む → 2. どの段の変更かを決める → 3. 影響の一覧 → 4. 一問一答で決める → 5. 書き換える → 6. 確かめて段ごとに承認 → 7. 版と CHANGELOG → 8. コミット → 9. Claude の Design System に写し直す、の順に進める。引数に `--local` があれば、9 をしない。

質問は必ず **AskUserQuestion** で出す。本文に質問を並べない。1 回に出すのは、答えが前の答えに依存しない質問だけ（最大 4 問）。選択肢をつけ、おすすめは先頭にして「(Recommended)」を付ける。調べれば分かることは質問しない。

## 0. 準備

- 対象のアプリのリポジトリを決める（`git rev-parse --show-toplevel`。アプリでなければ AskUserQuestion でパスを尋ね、以降は `cd <repo> && …` で実行する）。
- `design-system/design-system.json` がなければ、先に `/product-design:init` を実行するよう伝えて終える。`version` が 2 でない（v1）なら、v1 からの移行はまだこの版にないことを伝え、今は `/design-system:update` を使うよう勧めて終える。
- ① から ⑤ の `stages` に `pending` が残っていれば（⑤ の `outputs` は、`outputs` に出力があるときだけ数える。`status` の `next` を見る）、どちらの途中かを見分ける。`design-system/CHANGELOG.md` に版（`## 1.0.0` など）がまだなければ init の途中なので、`/product-design:init` で続きを終えるよう勧めて終える。版があれば前の update の途中で止まったので、変えたいことに入る前に、残った段の承認（6 の 3）から続ける。
- **写し直すだけのとき**: 変えたいことが「Design System に写す・写し直す」だけなら、1 の `status` を見たあと 9 へ直行する（版は上げず、CHANGELOG も書かない）。`artifact` がない（init が写す前に止まった）ときも同じ。
- 変えたいことが空なら、何を変えたいか尋ねる（`docs/design-candidates/` に `open` の候補があれば、それも選択肢に出す）。
- `git fetch -q origin` のあと `git status -sb` を見て、遅れていれば pull してよいか尋ねる。

## 1. 今のデザインシステムを読む

`docs/product/principles.md`、`design-system/` の文書と `tokens.json`、`components/`、`docs/design-candidates/` を読む。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs status <repo>
```

で、今の不備（`ds_errors`）・警告・古くなったもの・未決の候補も見ておく（変更とは別の不備があれば、最初にユーザーに伝える）。`stale` に `check.mjs` の行があれば、5 の最初に写し直す。`tokens.css` の行があれば 5 で作り直す。`Design System` の行があれば 9 で写し直す。

`outputs` に `html` がない（1 段階目の版で作った）なら、5 の `install` で HTML の出力が足される（`html_added`）。そのときは、この update の中で ⑤ の段（`/product-design:init` の 7）も行う。`install` はひな形の 18 部品の見本をすべて置くので、仕様（`components/*.md`）のない見本（HTML と CSS）は消して `index.html` から外し、見本のない仕様（自分で足した部品）には見本を作る。

## 2. どの段の変更かを決める

| 足りない・変えたいもの | 例 | 段 |
| :- | :- | :- |
| 判断の根拠 | 原則どうしがぶつかる、原則では決められない | ②（場合によっては ①） |
| トークン | 「強調」の色、もう一段大きい余白 | ③ |
| 部品 | チップ、星の評価、段階の表示 | ④ 部品 |
| 使い分け | シートか push か、削除は確認か取り消しか | ④ パターン |
| 文言 | この状況の言い方 | ④ 文言 |

**候補を決めるとき**（引数が `docs/design-candidates/` のファイルか、Claude Design の案）:

- Claude Design の案（Artifact の URL か HTML）なら、`Artifact` の `action: "read"` で読み、案の下の「部品の候補」を拾う。同じものが `docs/design-candidates/` にあれば `screens` に画面を書き足し、なければ候補のファイルを足す（形は `docs/design-candidates/README.md`）。
- 名前や中身が似た候補が複数あれば、まとめて見せ、1 つにまとめるかを尋ねる。
- 決めるのは 3 つのどれか（`DESIGN.md` 12節）:
  - **決まりにする**（`adopted`）: 足りなかった段を直す。目安は `screens` が 2 つ以上。どの `D` を根拠にするか言えないなら、② を見直す。
  - **この画面だけの例外にする**（`exception`）: 理由を書く。
  - **採らない**（`rejected`）: ある部品でどう作り直すかを書く。
- 決めたら、候補のファイルの `status` を変え、本文の最後に決めた日と理由を書き足す。

## 3. 影響の一覧

変えるものから下へたどって、影響を受けるものを一覧にする:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs trace <repo> --from <P1 | D2 | color.tint など>
```

`affected` を表にして見せ（深さ・場所・部品なら出力の名前と `files`）、AskUserQuestion で、どこまで直すかを決める。

- 原則（`P`・`D`）からは、トークン・基礎・部品・パターン・文言と、部品の HTML の出力のファイルまでたどれる。
- トークンからは、そのトークンを別名で使うトークンと、HTML の出力の CSS でそのトークン（`var(--…)`）を使う部品までたどれる。部品の仕様の文に書かれた使い方（「文字は `primary-foreground`」など）はたどれないので、変えるトークンの名前で部品の仕様も探して、一覧に足す。結果に `note` が付いたら（HTML の出力がない）、部品への影響は `$description` と部品の仕様を読んで自分で拾う。

## 4. 一問一答で決める

変えたいことを、決めるべき点に分けて聞く。

| 変更 | 決める点 |
| :- | :- |
| 原則を変える・足す | ① なら、標語・「A より B を優先する」・場面・捨てるもの（形と、書き直してもらう原則の判定は、init の 3（`${CLAUDE_PLUGIN_ROOT}/skills/init/SKILL.md`）と同じ。「どう感じさせるか」の原則は ② に回す。ほかの原則と同じ場面で逆のことを求めないかを見比べ、ぶつかるなら、どちらかの捨てるものに線引きを書く）。② なら「A より B」の形と根拠の `P`。どちらも、影響を受ける下の段をどう直すか |
| トークンを変える・足す | 新しい値（色はライトとダーク、文字に使う色はコントラスト比 4.5:1 以上をおすすめに）、どの役割まで変えるか、根拠の `D`、コントラストの組を足すか |
| 部品を足す・変える | 何のための部品か、似た部品で足りないか、構造・種類・状態、使う場面と使わない場面、根拠の `D` |
| パターン・文言を足す・変える | 決まりと例、根拠の `D` |
| 廃止する | 置き換え先と理由。消すのは次のメジャー版 |

## 5. 書き換える

- まず、プラグインの新しい版の `check.mjs` を写し直す（今の文書・トークン・部品の仕様は上書きせず、消したひな形も戻さない）:

  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs install <repo>
  ```

  結果の `available` は、アプリにないひな形（プラグインの新しい版で増えたものか、アプリで消したもの）。消したものかどうかを git の履歴（`git log --diff-filter=D -- <道のり>`）で確かめ、新しく増えたものだけ、足すかを尋ねる。足すなら `install <repo> --add <道のり,…>`。
- 変える段を直し、影響を受ける下の段を順に直す。書き方は `/product-design:init` と同じ（ID と `根拠:` の行、トークンの `from`・`modes.dark`・`contrast`、部品の先頭のメタデータ）。
- **⑤ HTML の出力**も直す（書き方は `/product-design:init` の 7）:
  - トークンを変えたら、`node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs tokens <repo>` で `tokens.css` を作り直す（手で直さない）。
  - 部品の仕様を変えた・足した・消したら、`design-system/html/components/` の見本のページと CSS を合わせ、`index.html` の一覧も直す。CSS で使ってよいのは `tokens.css` の変数だけ。
  - 変えた部品のスクリーンショットを撮り直す: `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs screenshot <repo> --pages <outputs.html の名前,…>`（仕様の `name` ではない。たとえばアラートは `alert-dialog`）。トークンを変えたなら、影響の一覧に出た部品をすべて撮る。`index.html` を変えたら `index` も撮る。消した部品の `design-system/screenshots/html/<名前>-*.png` は消す。変える前の画像は、撮り直す前にスクラッチへ写しておき、6 で前後を並べて見せる。
- **廃止**: 原則は消さずに、文書の最後の `## 廃止` の下に `### D4 …（廃止: 理由。置き換え: D6）` の形で移す。トークンは `$deprecated` に理由と置き換え先、部品は `status: deprecated` と置き換え先を書く。使っているところは、置き換え先に直すか、次のメジャー版まで残すかを決める。
- この時点では、まだ `stage` を記録しない（承認は 6 でもらう）。

## 6. 確かめて、段ごとに承認をもらう

1. `node <repo>/design-system/check.mjs --strict` が終了コード 0 で終わる。
2. `warnings` と `deprecated` を見て、変更で増えたものがあれば、それでよいかを確かめる。
3. **変えた段から下へ、1 段ずつ**承認をもらう。⑤（`outputs`）では、変えた部品のスクリーンショットの前後（ライトとダーク）を見せる。各段で、その段の前後の差分を見せ、AskUserQuestion で「この段を承認する / 直したいところがある」を確かめる。下の段に変更がなければ、「影響の一覧で、この段に直すものはない」と見せて承認をもらう。
   - 直すなら、4 に戻る（まだ `stage` は記録していないので、段の状態は崩れない）。
   - 承認されたら、その段を記録する:

     ```bash
     node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs stage <repo> <product|design|foundations|components|outputs> approved
     ```

     その下の承認済みの段は `pending` に戻るので、続けて下の段の承認をもらい、記録する。⑤（`outputs`）まで記録し終えるまで、7 に進まない。途中で止まって `pending` が残ったら、次の update の前に、残った段の承認から続ける。
4. `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs status <repo>` の `stale` に、`tokens.css` と `check.mjs` が出ていない。

## 7. 版と CHANGELOG

`design-system.json` の `ds_version` を上げる（`DESIGN.md` 13節。複数の種類が混ざったら、いちばん大きいものに合わせる）。

- メジャー: 役割や部品を消す・名前を変える、土台を変える
- マイナー: 役割・部品・種類・パターンを足す、原則を変える
- パッチ: 値の調整、文書の直し

`CHANGELOG.md` のいちばん上に、版、日付、変えたこと、根拠（どの ID）、影響を受けたファイルを書く。

## 8. コミット

変わったファイルを確かめてコミットする。メッセージはリポジトリの書き方に合わせ、何を変えたかを書く（例: `Design system 1.1.0: add the chip component`）。push はしない（ユーザーに尋ねる）。

## 9. Claude の Design System に写し直す

`--local` なら飛ばす。`design-system/design-system.json` に `artifact.url` があれば、その Design System を直す。なければ `/product-design:init` の 10 と同じく新しく作る。

`Artifact` のツールがないセッションなら写さずに、そのことを伝える（`stale` に「Design System が古い」が残り、次の update で写し直せる）。

1. 今の索引を読んで保存する: `Artifact` の `action: "read"`、`url` は `artifact.url`、`path` は `project/design-system.json`。保存された場所を、次の `--index` に渡す（索引のキーと名前を保つため）。読めない（共有されていない、消された）ときは、ユーザーに伝えて、新しく作るかを尋ねる。新しく作るなら、`/product-design:init` の 10 の 1〜5 に従う（`--title` を付け、表紙も作る）。
2. 写すファイルを並べる:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs artifact-stage <repo> <スクラッチのフォルダ>/artifact --index <1 で保存した索引> --by "<ユーザーの名前>"
   ```

   `skipped` があれば、その部品の見本のページを `/product-design:init` の 7 の 2 の形に直してからやり直す（並べていない部品は、3 で消すことになるため）。

3. 写した Design System のファイルの一覧（`Artifact` の `action: "list"`、`scope: "files"`）と比べ、今は並べていない `project/components/<名前>/…`（消した部品）があれば、`files` にその道のりを `null` で足して消す。表紙（`project/components/Cover/preview.html`）は消さない。名前・色・角丸が変わったときだけ、型の `cover.md` に従って作り直して足す。
4. 1 回の `publish` で送る（`url`、`root`、`file_path` は索引、`files`）。ほかの人がページで保存していて断られたら、1 からやり直す（1 回まで）。
5. `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs artifact-done <repo> <url> --hash <2 の hash>` で記録し、`design-system/design-system.json` をコミットする。

## 終わりに

変えたこと、新しい版、直した下の段と HTML の出力、決めた候補、Design System を写し直したか（url）を短く伝える。
