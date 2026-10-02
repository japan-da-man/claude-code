# claude-code

japan-da-man の Claude Code プラグイン（mods を含む）を管理するマーケットプレイス。

## プラグイン

| 名前 | 内容 |
| :- | :- |
| [todo-mod](plugins/todo-mod) | `/todo` で TODO パネルを開く。チェックを入れたタスクを Claude に依頼する |

## インストール

```bash
claude plugin marketplace add japan-da-man/claude-code
claude plugin install todo-mod@japan-da-man
```

更新:

```bash
claude plugin update todo-mod@japan-da-man
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

## プラグインの追加

1. `plugins/<name>/` に `.claude-plugin/plugin.json` と中身を置く
2. `.claude-plugin/marketplace.json` の `plugins` にエントリを追加する（`name` は `plugin.json` と同じにする）

`plugin.json` に `version` を書いていないので、コミットごとに新しいバージョンとして扱われる。

mods は Claude Code v2.1.287 以降が必要。
