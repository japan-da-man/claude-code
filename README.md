# claude-code

japan-da-man の Claude Code プラグイン（mods を含む）を管理するマーケットプレイス。

## プラグイン

| 名前 | 内容 |
| :- | :- |
| [japan-da-man-mods](plugins/japan-da-man-mods) | **まとめてインストール用**。下の mod を全部入れる |
| [todo-mod](plugins/todo-mod) | `/todo` で TODO パネルを開く。チェックを入れたタスクを Claude に依頼する |
| [token-weather](plugins/token-weather) | コンテキストの埋まり具合を天気（☀ Clear → ⛈ Storm）でプロンプトの上に表示する。`/weather` で表示切り替え |
| [usage-stats](plugins/usage-stats) | `/stats` で利用統計のパネルを開く。セッション数・メッセージ数・トークン数・利用日数・連続日数・よく使うモデル・日ごとのヒートマップ |

## インストール

```bash
claude plugin marketplace add japan-da-man/claude-code
claude plugin install japan-da-man-mods@japan-da-man
```

1つずつ入れる場合は `claude plugin install <名前>@japan-da-man`。

更新:

```bash
claude plugin update japan-da-man-mods@japan-da-man
```

## 開発

インストールせずに作業中のディレクトリを読み込む（保存するとホットリロードされる）:

```bash
claude --plugin-dir ./plugins/todo-mod
```

チェック:

```bash
claude plugin validate .
claude plugin validate ./plugins/todo-mod
```

テスト（`tests/*.test.ts` があるプラグイン）:

```bash
cd plugins/<name> && claude plugin test
```

## プラグインの追加

このリポジトリで Claude Code を開いて「〇〇する mod を追加して」と頼むと、プロジェクト skill [`add-mod`](.claude/skills/add-mod/SKILL.md) が下の手順（雛形・テスト・marketplace / bundle / README 更新・validate）をまとめてやる。手でやる場合:


1. `plugins/<name>/` に `.claude-plugin/plugin.json` と中身を置く
2. `.claude-plugin/marketplace.json` の `plugins` にエントリを追加する（`name` は `plugin.json` と同じにする）
3. まとめて入るようにするなら `plugins/japan-da-man-mods/.claude-plugin/plugin.json` の `dependencies` にも名前を足す

`plugin.json` に `version` を書いていないので、コミットごとに新しいバージョンとして扱われる。

mods は Claude Code v2.1.287 以降が必要。
