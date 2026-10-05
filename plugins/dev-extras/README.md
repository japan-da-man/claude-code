# dev-extras

オープンソースの skill から選んで取り込み、少しだけ手を入れたもの。元はすべて MIT ライセンスで、各ライセンスは [licenses/](licenses) に置いている。

| skill | 呼び方 | 内容 | 元 |
| :- | :- | :- | :- |
| `ponytail` | `/dev-extras:ponytail [lite\|full\|ultra]` | 「怠け者のシニア開発者」として、必要性 → 既存コード → 標準機能 → 既存の依存 → 1 行 の順に検討し、最小の実装にする。`stop ponytail` で解除 | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) |
| `ponytail-review` | `/dev-extras:ponytail-review` | 作り込みすぎだけを探すレビュー。何を消せるかを 1 行ずつ、`net: -N lines possible.` で締める。修正はしない | 同上 |
| `grill-me` | `/dev-extras:grill-me` | 計画や設計を、決定の木をたどりながら質問攻めで詰める。各質問に推奨回答つき。手動でだけ呼ぶ | [mattpocock/skills](https://github.com/mattpocock/skills) |
| `grilling` | （`grill-me` が呼ぶ） | 質問攻めの本体 | 同上 |
| `handoff` | `/dev-extras:handoff <次に何をするか>` | 会話の要約を作り、`claude --bg` で新しいバックグラウンドエージェントに引き継ぐ。秘密情報は伏せる | 同上（`claude-handoff`） |
| `verification-before-completion` | 自動 | 「終わった」「直った」「通った」と言う前に、検証コマンドを実際に流して出力を確かめる | [obra/superpowers](https://github.com/obra/superpowers) |
| `security-audit` | 「セキュリティ監査して」 | 信頼境界を越える脆弱性だけを、ソースを根拠に探す。通常は助言モード、明示的に頼んだときだけ 6 段階の完全な監査（成果物を書く） | [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) |

## このリポジトリでの変更

- skill 名を名前空間つきの呼び方（`/dev-extras:…`）に合わせた（`grill-me` が `dev-extras:grilling` を呼ぶ、など）。
- `claude-handoff` を `handoff` に改名した。
- 説明文に日本語のトリガー語を足し、出力は使っている言語に合わせるよう 1 行足した。
- 本文のロジックは変えていない。`security-audit` は説明文の先頭に日本語を足しただけで、ほかは元のまま。

## 注意

- `ponytail` は**入れると毎回の応答に効く**（`stop ponytail` か「通常モード」で解除）。常に効かせたくなければ、使うときだけ呼ぶ。
- `security-audit` の完全な監査は、サブエージェントを何度も呼び、サンドボックスの有無に依存する。実行前に範囲とプロファイル（`quick` / `standard` / `deep`）を決めること。
- 元のリポジトリが更新されても自動では追従しない。取り込み時点は 2026-10-05。
