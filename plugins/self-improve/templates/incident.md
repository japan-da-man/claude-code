---
id: INC-YYYY-NNNN          # harness-note incident add が振る（全リポジトリで 1 つの連番）
date: YYYY-MM-DD
repo: example-app          # どのリポジトリで起きたか（名前）
repo_id: example-app-0123456789ab
remote: null               # リモートの URL（認証情報は取り除いてある）
area: unknown              # 値はリポジトリごとに決める（backend / mobile など）
category: dev/mistake      # 改善候補のカテゴリ
signal: noticed            # tool_failure / human_correction / guard_denied / verify_failed / noticed
root_cause: knowledge      # knowledge / procedure / forbidden / verification / structure / judgment / environment / one_off
cause_key: example-key     # 「同じ原因」を表す短いキー
related: []                # 同じ cause_key の過去の失敗票
severity: normal           # normal / high
status: open               # open / trial / converted / wontfix / retired
control: null              # 足した制御の場所（試用ルールは trial:rules/<cause_key>、試用Skillは skill:<名前>、自分専用は personal:<パス>、チームはリポジトリの中のパス）
applied_by: null           # auto（自動改善）/ human
trial_started_at: null
promoted_at: null
---

## 何を頼んだか

## 期待した結果

## 実際の結果

## 根拠

- セッションID：
- 事象メモ：
- コミット：
