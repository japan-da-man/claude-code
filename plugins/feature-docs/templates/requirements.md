---
id: REQ-0000
title: <企画名（利用者から見てできるようになること）>
status: draft            # draft → approved（要件の PR）→ designed（設計の PR）→ implemented（最後の PR）。却下は rejected / withdrawn と reason
requested_by: <依頼者>
priority: medium         # high / medium / low
issue: null              # 企画の Issue 番号（あれば）
features:
  new: []                # 新しく作る機能の ID（next-id feature で取る）
  changed: []            # 変える既存の機能の ID（機能マスタにあるもの）
actors: []               # 対象のアクター（actors.yaml の id）
new_actors: []           # 新しいアクター（id・name・kind: human / system・description）。最後の PR で actors.yaml に足す
ui: null                 # 画面が変わらないなら none
supersedes: []           # 置き換える過去の要件定義書（承認後に要件を変えたくなったら、新しい要件定義書を起こしてここで参照する）
---

# <企画名>

## 背景と課題

<なぜ今これが必要か。誰がどんなことに困っているか>

## 目的とKPI

- 目的: <>
- KPI: <名前・定義・目標値・計測期間>

## 誰が・いつ

<アクター、JTBD、利用シーン。既存の機能を変えるときは、機能マスタとの差分で書く>

- アクター: <A-xxx>
- JTBD: <〜なとき、〜したい。そうすれば〜できる>
- 利用シーン: <いつ・どこで・どのくらいの頻度で・どんな状態で>
- 機能マスタへの差分: <例: F-012 の scenes に「…」を足す>

## 利用者の流れ

<利用者から見た流れ。システム内部の処理は書かない>

1. <>
2. <>

代わりの流れ・うまくいかないとき:

- <条件>: <利用者に見えること>

## スコープ / 非ゴール

- やる: <>
- やらない: <>

## 受け入れ条件

<利用者から見た Given / When / Then。設計書で技術的に具体化し、Maestro のフローに対応させる>

- Given <> When <> Then <>

## 画面と状態

<画面の一覧と、各画面の状態（あり・空・読み込み中・エラー・オフライン など）。見た目はここでは決めない>

- <画面>: <状態>

## 制約

<期限、対象のプラン、法務・規約の制約など。なければ「なし」>

## 未決事項

- <まだ決まっていないこと。検討して却下した案とその理由もここに>
