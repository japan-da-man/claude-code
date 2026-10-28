# feature-docs: 要件・設計・機能マスタの決まり

このリポジトリでは、企画から公開までの成果物を **3 つに分けて、すべてリポジトリで管理する**（外部のツールに正本を置かない）。承認は PR のマージ。人とエージェントの両方がこの決まりに従う。

| 成果物 | 置き場所 | 性質 | 更新する PR |
| --- | --- | --- | --- |
| 企画・要件定義書 | `docs/requirements/REQ-xxxx-*.md` | 変更要求。承認後は status 以外を変えない | ① 要件の PR |
| 設計書 | `docs/design/F-xxx-*.md` | 機能ごとの今の設計（振る舞いと裏側） | ② 設計の PR |
| UI 案 | `docs/ui/REQ-xxxx/` | 確定した UI 案のスナップショット | ② 設計の PR |
| トラッキングプラン | `tracking/F-xxx.yaml` | 計測の設計 | ② 設計の PR |
| 機能マスタ | `features/F-xxx-*.yaml` | 今提供している機能の、利用者から見た事実 | ③ 最後の PR |
| 共通マスタ | `actors.yaml` / `glossary.yaml` | アクターと用語 | 必要な PR で |
| プロダクト要件 | `docs/product/overview.md` | 全体の目的・KPI・非機能要件 | 方針が変わるとき |
| システム全体図 | `docs/architecture/*.md` | 構成（Mermaid の flowchart） | 構成が変わるとき |
| ADR | `docs/adr/NNNN-*.md` | 設計の判断の記録 | 大事な判断のたび |

## 流れ

1. 企画（Issue など）→ **要件定義**（AI と一問一答）→ ① 要件の PR をマージ（＝要件の承認）
2. **設計と UI 案**（AI）→ ② 設計の PR をマージ（＝設計の承認）
3. **実装**：統合ブランチ `feature/REQ-xxxx` に、テストの通った小さな PR を自動でマージしていく
4. **仕上げ**：機能マスタ・ヘルプの項目・changelog を更新し、設計書の pending を外す → ③ 統合ブランチから main への PR をマージ（＝最終レビュー）
5. main にマージされると、CI がヘルプ AI 用のナレッジを書き出す

## 決まり

- 機能マスタには **利用者から見た事実だけ** を書く。API・データ・フラグ・イベント・画面のルートは設計書かトラッキングプランへ（チェッカーが落とす）。
- 機能マスタには計画中の機能を載せない。最後の PR で初めて足す。
- 要件定義書は差分で書く（「F-012 に利用シーンを足す」）。機能マスタへの反映は最後の PR で行う。
- 承認後に要件を変えたくなったら、要件定義書を書き換えずに、新しい要件定義書を起こして `supersedes` で参照する。
- 設計の PR で、変える機能の設計書の `pending` に REQ の ID を付け、最後の PR で外す。`> 未実装（REQ-xxxx）` の節は「これから作る内容」として読む。
- 機能 ID（F-xxx）は変えず、消さない。提供をやめたら `status: deprecated`。
- 要件の変更は必ず PR で行う。

## チェック

```bash
node feature-docs/check.mjs                 # 整合を調べる（誤りがあれば終了コード 1）
node feature-docs/check.mjs status          # 要件定義書ごとの段階と次にやること
node feature-docs/check.mjs next-id req     # 次の REQ 番号（feature で F 番号）
node feature-docs/check.mjs export-help     # ヘルプ AI 用のナレッジを書き出す
```

テンプレートは feature-docs プラグインの `templates/` にある（`/feature-docs:requirements` などのスキルが使う）。
