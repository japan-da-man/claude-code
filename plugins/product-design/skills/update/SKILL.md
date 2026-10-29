---
name: update
description: デザインシステムを変える（原則を変える、色・文字・余白などのトークン、部品の仕様、画面の型、文言の決まりを足す・変える、docs/design-candidates/ の候補や Claude Design の案の「部品の候補」を決める）。変えるものから下の段への影響を一覧にし、人が一問一答で決め、その段と影響を受ける下の段を直し、版を上げて CHANGELOG を書く。「デザインシステムに〇〇を足して」「原則を変えたい」「この候補を決めて」「/product-design:update <変えたいこと>」と言われたときに使う。
argument-hint: "<変えたいこと | 候補のファイル | Claude Design の案の URL>"
model: opus
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *) Bash(node design-system/check.mjs*) Bash(git fetch *) Bash(git status*) Bash(git rev-parse *) Bash(git diff*) Bash(git add *) Bash(git commit *)
---

# product-design:update: デザインシステムを変える

変えたいこと: $ARGUMENTS

デザインシステムは人が決めるもの。ここで一問一答で決めてから変える。上の段を変えたら、影響を受ける下の段まで直す。設計は `${CLAUDE_PLUGIN_ROOT}/DESIGN.md`。

0. 準備 → 1. 今のデザインシステムを読む → 2. どの段の変更かを決める → 3. 影響の一覧 → 4. 一問一答で決める → 5. 書き換える → 6. 確かめる → 7. 版と CHANGELOG → 8. コミット、の順に進める。

質問は必ず **AskUserQuestion** で出す。本文に質問を並べない。1 回に出すのは、答えが前の答えに依存しない質問だけ（最大 4 問）。選択肢をつけ、おすすめは先頭にして「(Recommended)」を付ける。調べれば分かることは質問しない。

## 0. 準備

- 対象のアプリのリポジトリを決める（`git rev-parse --show-toplevel`。アプリでなければ AskUserQuestion でパスを尋ね、以降は `cd <repo> && …` で実行する）。
- `design-system/design-system.json` がなければ、先に `/product-design:init` を実行するよう伝えて終える。`version` が 2 でない（v1）なら、v1 からの移行はまだこの版にないことを伝え、今は `/design-system:update` を使うよう勧めて終える。
- ① から ④ の `stages` に `pending` が残っていれば、先に `/product-design:init` で続きを終えるよう勧める（途中の段を update で変えると、承認の順が崩れるため）。
- 変えたいことが空なら、何を変えたいか尋ねる（`docs/design-candidates/` に `open` の候補があれば、それも選択肢に出す）。
- `git fetch -q origin` のあと `git status -sb` を見て、遅れていれば pull してよいか尋ねる。

## 1. 今のデザインシステムを読む

`docs/product/principles.md`、`design-system/` の文書と `tokens.json`、`components/`、`docs/design-candidates/` を読む。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs status <repo>
```

で、今の不備（`ds_errors`）・警告・古くなったもの・未決の候補も見ておく（変更とは別の不備があれば、最初にユーザーに伝える）。`stale` に `check.mjs` があれば、5 の最初に写し直す。

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

`affected` を表にして見せ（深さ・場所・部品なら出力の名前）、AskUserQuestion で、どこまで直すかを決める。

## 4. 一問一答で決める

変えたいことを、決めるべき点に分けて聞く。

| 変更 | 決める点 |
| :- | :- |
| 原則を変える・足す | 「A より B」の形、根拠（② なら `P`）、影響を受ける下の段をどう直すか |
| トークンを変える・足す | 新しい値（色はライトとダーク、文字に使う色はコントラスト比 4.5:1 以上をおすすめに）、どの役割まで変えるか、根拠の `D`、コントラストの組を足すか |
| 部品を足す・変える | 何のための部品か、似た部品で足りないか、構造・種類・状態、使う場面と使わない場面、根拠の `D` |
| パターン・文言を足す・変える | 決まりと例、根拠の `D` |
| 廃止する | 置き換え先と理由。消すのは次のメジャー版 |

## 5. 書き換える

- まず、プラグインの新しい版を取り込む（`check.mjs` を写し直し、ないひな形だけ足す。今の文書とトークンは上書きしない）:

  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs install <repo>
  ```

- 変える段を直し、影響を受ける下の段を順に直す。書き方は `/product-design:init` と同じ（ID と `根拠:` の行、トークンの `from`・`modes.dark`・`contrast`、部品の先頭のメタデータ）。
- **廃止**: 原則は消さずに、文書の最後の `## 廃止` の下に `### D4 …（廃止: 理由。置き換え: D6）` の形で移す。トークンは `$deprecated` に理由と置き換え先、部品は `status: deprecated` と置き換え先を書く。使っているところは、置き換え先に直すか、次のメジャー版まで残すかを決める。
- 段を承認したら、その段を記録する（その下の承認済みの段は `pending` に戻るので、下の段も順に承認し直す）:

  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs stage <repo> <product|design|foundations|components> approved
  ```

## 6. 確かめる

1. `node design-system/check.mjs --strict` が終了コード 0 で終わる。
2. `warnings` と `deprecated` を見て、変更で増えたものがあれば、それでよいかを確かめる。
3. 変えたものの前後（差分）を見せ、AskUserQuestion で「この変更で承認する / 直したいところがある」を確かめる。直すなら 4 に戻る。

## 7. 版と CHANGELOG

`design-system.json` の `ds_version` を上げる（`DESIGN.md` 13節。複数の種類が混ざったら、いちばん大きいものに合わせる）。

- メジャー: 役割や部品を消す・名前を変える、土台を変える
- マイナー: 役割・部品・種類・パターンを足す、原則を変える
- パッチ: 値の調整、文書の直し

`CHANGELOG.md` のいちばん上に、版、日付、変えたこと、根拠（どの ID）、影響を受けたファイルを書く。

## 8. コミット

変わったファイルを確かめてコミットする。メッセージはリポジトリの書き方に合わせ、何を変えたかを書く（例: `Design system 1.1.0: add the chip component`）。push はしない（ユーザーに尋ねる）。

## 終わりに

変えたこと、新しい版、直した下の段、決めた候補を短く伝える。
