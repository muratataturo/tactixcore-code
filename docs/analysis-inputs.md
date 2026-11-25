# 分析入力と成果物

すべての入力パスは playground ルート相対または playground 内の絶対パスです。例のファイル名と ID は、コーチが対象範囲を確認した資料に置き換えます。既存エンジンが解釈する動画台帳や注記内の参照も実行前に確認します。

## 自チーム分析

```json
{
  "schema": 1,
  "skill": "soccer-ownteam",
  "team_id": "TEAM_ID",
  "game_id": "GAME_ID",
  "team_name": "自チーム名",
  "items": "path/to/items",
  "videos": "path/to/videos.json",
  "detections": "path/to/detections.json",
  "keypoints": "path/to/keypoints.json"
}
```

## 敵チーム分析

```json
{
  "schema": 1,
  "skill": "soccer-opponent",
  "team_id": "TEAM_ID",
  "game_id": "GAME_ID",
  "opponent_id": "OPPONENT_ID",
  "team_name": "自チーム名",
  "opponent": "公開されている対戦相手名",
  "competition": "公開大会名",
  "as_of": "2026-11-25",
  "formation": "4-2-3-1",
  "items": "path/to/items",
  "video_files": ["path/to/match.mp4"],
  "video_match_opponent": "分析映像で相手が対戦しているチーム",
  "video_annotated_team": "opponent",
  "video_coverage_note": "前半のみ",
  "source_registry": "path/to/public-sources.csv"
}
```

`source_registry` は任意です。注記が相手チーム視点の場合は `opponent`、対戦した別チーム視点の場合は `other` を選びます。エンジンの公開検索に使われるチーム名・大会名は公開可能な表記を選びます。

## 選手個人分析

```json
{
  "schema": 1,
  "skill": "soccer-player",
  "team_id": "TEAM_ID",
  "game_id": "GAME_ID",
  "player_id": "PLAYER_ID",
  "video_id": "VIDEO_ID",
  "video": "path/to/match.mp4",
  "comments": "path/to/v4-comments-export.json",
  "tracks_dir": "path/to/spatial/tracks",
  "confirmed_annotation_ids": ["ANNOTATION_ID"]
}
```

コメント出力にも同じ `team_id`、`game_id`、`video_id` が必要です。指定する注記は、コーチが本人の場面と確認した、人が書いた注記です。1件から12件を選びます。

## レポート

出力先は `temp/<分析種別>/<team>/tactixcore-code/reports/<game>_vNNN/` です。分析種別は `ownanalysis`、`enemyanalysis`、`playeranalysis` のいずれかです。完了時に HTML レポート、エンジンが生成した根拠 JSON、対象・入力・実行版を記録した `tactixcore-run.json`、保管用の `manifest.json` を残します。世代の整理は playground の storage lifecycle を使います。

## 改善候補の観察入力

確認した結果を、問題の種類、Skill ID、32桁の trace ID で渡します。下記は形式例です。

```json
[
  {
    "kind": "missing_evidence",
    "skill_id": "soccer-ownteam",
    "trace_id": "0123456789abcdef0123456789abcdef",
    "reviewed": true
  }
]
```

種類は `missing_evidence`、`opponent_scope_mismatch`、`player_unconfirmed`、`stale_source`、`inaccessible_source`、`unsupported_evidence_review` です。最後の種類では `skill_id` を `null` にします。繰り返しの判定には異なる trace ID を使い、同一トレースの重複を数えません。候補は playground の `.local/autonomy/tactixcore-code-candidates/` へ保存します。
