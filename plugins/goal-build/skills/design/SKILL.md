---
name: design
description: 要件定義書から設計書 SPEC.md を書き、分からない点を QUESTIONS.md の「設計」にまとめて止まる。回答があれば SPEC.md に反映する。goal-build の最初の段階。実装はしない。
disable-model-invocation: true
arguments: [feature, requirements]
argument-hint: <feature-slug> <要件定義書のパス | spec-flow の docs/specs/<id>>
---

# goal-build: 設計

要件定義書を読んで、実装に入れる粒度の設計書 `docs/specs/$feature/SPEC.md` を書く。このスキルではコードを変更しない（書くのは `docs/specs/$feature/` の下だけ）。分からないことは推測で埋めず、まとめて人に聞いて止まる。

- feature: `$feature`
- 要件: `$requirements`

## 手順

1. **実行中のフローがないか**：`.goal-build/active` があれば、別の機能が実装中か PR 待ちになっている。その機能のパスと state（`.goal-build/state`）を伝え、`/goal-build:finish` で終えてから始めるよう頼んで止まる。`.goal-build/config` がなければ `/goal-build:setup` を先に実行するよう伝えて止まる。
2. **要件を読む**：
   - `$requirements` がファイルなら、それを読む。
   - `$requirements` が spec-flow の `docs/specs/<id>/` なら、`03-requirements.md`（要件）と `04-options.md`（`progress.json` の `chosen` の案）を読み、`01-request.md`・`02-impact.md` も参考にする。`$feature` を同じ id にすると、同じディレクトリに SPEC.md を置ける。
   - `docs/specs/$feature/SPEC.md` が既にあれば、再実行として手順 6 へ進む。
3. **既存コードを調べる**：Explore サブエージェントに、関係するルーティング・スキーマ・データモデル・似た既存機能・テストの書き方を調べさせる。結論とファイルパスだけを受け取る。
4. **SPEC.md を書く**：`${CLAUDE_PLUGIN_ROOT}/references/spec-template.md` に従う。frontmatter は `status: draft`。受け入れ基準には ID（AC-1, AC-2 …）を振り、利用者から見て確かめられる形で書く。テスト計画は受け入れ基準ごとに書く。
5. **質問をまとめる**：分からない点、要件どうしの矛盾、要件に書かれていない判断を、`${CLAUDE_PLUGIN_ROOT}/references/questions-format.md` に従って `docs/specs/$feature/QUESTIONS.md` の「設計」節にまとめる。読めば分かることは質問にしない。
6. **再実行のとき**：QUESTIONS.md の回答を SPEC.md に反映し、答えの出た質問は残したまま（消さない）、新しく出た疑問だけを足す。人が SPEC.md を直接直していれば、それを優先する。
7. **止まる**：SPEC.md は `status: draft` のまま。次の形で報告して終える。
   - 書いた／直したファイル
   - 設計の要点（3〜5 行）
   - 未回答の質問の数（blocking / non-blocking）。あれば「QUESTIONS.md に回答して `/goal-build:design $feature $requirements` を実行し直してください」
   - 未回答の blocking がなければ、承認の手順：SPEC.md を読んで frontmatter を `status: approved` に書き換え、**新しいセッション**を auto モードで開いて次を実行する（`<feature>` を埋めて見せる）

     ```text
     /goal 最初に Skill ツールで goal-build:implement を引数 <feature> で呼び、その手順に従って docs/specs/<feature> を実装する。
     次のすべてが会話に示されたら達成：
     (1) .goal-build/check.sh の最後の実行が exit 0 で、その出力を会話に出している
     (2) 最新のレビュー結果で blocking の指摘が 0 件
     (3) goal-build:report で REPORT.md と PR_BODY.md を作成したと報告している
     ただし次のどれかを報告した場合も、その時点で終了とする：
     - blocking な質問を QUESTIONS.md に書き .goal-build/state を blocked にした（保留した AC、2 周後に残ったレビュー指摘、check.sh の連続失敗を含む）
     - SPEC.md が approved でないため開始しなかった
     SPEC.md と既存テストの期待値は変更しない。PR の作成はしない。
     40 ターンで打ち切る。
     ```

## 守ること

- SPEC.md の `status` を `approved` にしない（承認は人だけがする）。
- 実装コード・テストを書かない。設計のために試しにコードを書く必要があれば、その旨を質問にする。
