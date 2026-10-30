# 障害の記録

1 件の障害を `YYYY-MM-DD-<name>.md` に記録する（ひな形は `/observability:triage` が使う）。
調べている間は `status: investigating`、影響が止まったら `mitigated`、原因と再発防止まで書けたら `resolved` にする。
resolved にはポストモーテムの節（概要・影響・時系列・原因・対処・再発防止）が要る（`observability/check.mjs` が調べる）。
