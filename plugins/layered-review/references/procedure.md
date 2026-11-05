# レビューの手順（探す → 投票で確かめる → 分ける）

`review` と `eval` が共通で使う手順。呼び出し側から次を受け取る。

| 受け取るもの | 例 |
| :- | :- |
| `repo_dir` | 読むコードの場所。作業ツリーか、`git worktree` で取り出した場所 |
| `range` | `<base>...<head>`、または作業ツリーなら `<base>`（未コミットも含む） |
| `mode` | `quick` / `standard` / `deep` |
| `intent` | 変更の目的（PR の本文、コミットのメッセージ、ユーザーの説明）。なければ「不明」 |
| `rules` | **いまの** リポジトリの `REVIEW.md` と `CLAUDE.md` のパス（eval でも、評価するのは今の決まり） |
| `scope` | `full`（変更全体）か `diff`（前回から増えた差分だけ。`range` がその差分になる） |
| `reported` | これまでに出した指摘（同じものを出さないため）。1 回目は空 |
| `previous_open` | まだ直っていない Important（直ったかを確かめるため）。1 回目は空 |

## 1. 探す

モードで、サブエージェント `layered-review:bug-hunter`（見つからなければ `general-purpose` に `${CLAUDE_PLUGIN_ROOT}/agents/bug-hunter.md` の本文を指示として渡す）を **並べて** 走らせる。観点は 1 人に 1 つ。

| モード | 観点 |
| :- | :- |
| quick | 1 人で A・B・C をまとめて |
| standard | A・B・C を 1 人ずつ（3 人） |
| deep | A・B・C・D・E を 1 人ずつ（5 人） |

- **A. 変更の中の正しさ**：境界値、null・undefined、エラーの経路、非同期と順序、状態の更新、型の穴
- **B. 周りとの噛み合い**：呼び出し元・呼び出し先、API の取り決め（リクエスト・レスポンスの形）、設定、同じ名前の別の実装、文書・機能マスタ・CLAUDE.md との食い違い。この変更が **ほかの場所を壊すか**
- **C. セキュリティとデータ**：認証・認可、入力の検証、秘密の値、個人情報、データの整合とマイグレーション、課金
- **D. 意図と根本原因**：変更が `intent` を本当に果たすか。バグの修正なら、症状ではなく根本原因を直しているか。テストが本当に失敗しうるか
- **E. 出したあと**：後方互換（古いアプリの版と新しい API など）、リリース・設定・feature flag、戻せるか、性能の落ち込み

各エージェントに渡すのは、上の表のものと担当の観点だけ。**作った経緯や作者の自信は渡さない。**

`scope: diff` のときは、`range` の差分だけを見るよう伝える。`previous_open` は B の担当（quick なら 1 人）に渡し、直ったかを `previous` に返させる。

## 2. まとめる

返ってきた指摘をまとめる。

- 同じ場所・同じ原因の指摘は 1 つにする（観点の違うエージェントが同じものを見つけたら、それは強い手がかり）。
- `reported` と同じもの（同じファイル・種類・内容）は落とす。
- 書き方の好み・フォーマット・命名だけの指摘は落とす（REVIEW.md の「指摘しないこと」も）。落とした数は数えておく。
- 同じ種類（`class`）のバグがいくつかの場所にあれば、1 つの指摘にまとめ、場所をすべて `locations` に挙げる。

## 3. 投票で確かめる

まとめた指摘を、サブエージェント `layered-review:verifier`（なければ `general-purpose` に `${CLAUDE_PLUGIN_ROOT}/agents/verifier.md`）に渡す。**指摘ごとに別のエージェントを立てるのではなく、1 人に全部を渡す。** 人数はモードで決める。

| モード | 確かめる人数 | 残す条件 |
| :- | :- | :- |
| quick | 1 | confirm |
| standard / deep | 3（並べて走らせる） | confirm が 2 つ以上 |

渡すのは、指摘（`path`・`line`・`title`・`trigger`・`why`）と `repo_dir`・`range` だけ。**誰が見つけたか、何人が見つけたかは渡さない。**

- 残す条件を満たさないものは落とす。ただし `severity: critical` で、confirm が 1 つでもあり refute がないものは、落とさずに「確かめきれなかったこと」に回す（重い見逃しを投票で消さないため）。
- verifier が直した `severity` や `trigger` があれば、多いほうを採る。

## 4. 分ける

残った指摘を JSON の配列（`path`・`line`・`class`・`title`・`severity`・`caused_by_change` があればそれも）にして一時ファイルに書き、変更の中か外かを機械で分ける。`--base` は **変更全体** の分岐点にする（`scope: diff` のときも。前からあったかは、変更全体から見て決める）。作業ツリーを見ているときは `--head` を付けない。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs classify --repo <repo_dir> --base <変更全体の分岐点> [--head <head>] --findings <tmp.json>
```

`origin` と `fp` が付いて返る。それを使ってラベルを付ける。

| ラベル | 条件 |
| :- | :- |
| `important` | `origin: introduced` で、severity が critical / high / medium |
| `nit` | `origin: introduced` で、severity が low |
| `pre-existing` | `origin: pre-existing`（この変更より前からある。作者に直させない） |

## 5. 返すもの

呼び出し側に、次を返す。

- 指摘（ラベル・`fp`・`path:line`・`locations`・`class`・`severity`・`title`・`trigger`・`suggestion`）。severity の重い順
- `previous`：`previous_open` のそれぞれが `fixed` か `open` か
- 落とした数（書き方だけ・重複・投票で落ちたもの）
- 確かめきれなかったこと
- 走らせたエージェントの数（探す人・確かめる人）
