# TactixCore Code の実装計画

公開リポジトリに Pi 拡張と再利用可能な Skills を置き、playground の分析を型付きアダプターで呼び出す。ソースの移植は許諾と公開範囲を確認したファイル単位で行い、チーム資料、動画、レポート、認証設定、セッション、実行ログは各利用環境に保持する。移植元は playground の `apps/tactixcore_code`。分析本体は `dataset_collector` にある。

## 現在の実装範囲

- 依存のインストール、ローカル CLI、3つの分析接続、公開検索、候補作成コマンドを実装済み。現行の使い方は [README](../README.md) を参照。
- Pi の推論と OTLP は合成ストリーム、分析接続は模擬エンジンを使って検証済み。実試合の受入、実モデルを使った Pi の E2E、Python 工程別の計装と接続は未検証。
- 改善は観察の重複排除と候補の作成まで。既存ランナーへの評価キューの接続、独立評価、昇格、Span Link は残っている。

## PR 1 — 配布と OpenRouter の接続確認

- **変更** — Node.js CLI と npm の配布ファイル一覧を追加する。外部 dotenv は `--env-file` で明示し、Node の dotenv パーサーから `OPENROUTER_API_KEY` だけを読む。省略時は同名の環境変数を使う。GET `/api/v1/key` は固定の HTTPS 宛先に送り、リダイレクトを拒否する。
- **受入** — clone したソースから1コマンドで導入できる。`doctor` はオフラインで動作し、`check-openrouter` は許可した値だけを出力する。認証失敗・タイムアウト・リダイレクトを扱う。git index と npm 配布物に認証ファイルやキーを含めない。
- **テスト** — ダミーキーと HTTP アダプターで確認する。実クレジットを消費するテストはこの PR の範囲外。

## PR 2 — Pi の実行基盤、OpenRouter、自動モデル選択、OTLP

- **変更** — Pi のバージョンを固定し、CLI から起動する。既存の自動 Skill 選択とモデル選択を別工程にする。OpenRouter の接続は信頼済みの推論アダプターが所有し、分析ツール・検索・子プロセスへ秘密を継承しない。Pi との接続は固定した版の provider hook または IPC を使い、Pi 側の標準ツールとローカル拡張は明示的に許可する。
- **ルーティング** — アプリ内の `agentrouter/auto` は `openrouter/auto` に解決する。工程ごとに画像入力・tool calling・構造化出力・送信範囲・予算からモデル候補を絞る。分類・抽出は軽量優先、戦術統合と評価は各 Skill の品質条件を優先する。候補が空なら実行を止める。リトライとフォールバックは同じ制約に従う。評価・再実行用に固定モデルも選べる。
- **監視** — GenAI Semantic Conventions の採用版を固定する。依頼を起点に Skill 選択、推論、tool call を親子 span にする。実モデル、取得できたフォールバック、トークン、実課金、失敗、所要時間、ルーティングポリシー版を記録する。アプリ固有属性は `tactixcore.*` を使う。本文、映像 URL、認証値、選手名を除外して OTLP Collector に送る。
- **受入** — streaming の終端チャンクから実モデルと利用情報を取得する。ルーター情報の欠落は取得状況を残す。ダミー Collector 上で trace を親子関係つきで確認し、認証エラー・利用上限・タイムアウト時の制御を検証する。

参照 [OpenRouter Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router) · [Router Metadata](https://openrouter.ai/docs/guides/routing/routers/router-metadata) · [OpenTelemetry GenAI Semantic Conventions](https://github.com/open-telemetry/semantic-conventions-genai)

## PR 3 — 自チーム分析を一試合通す

- **変更** — `soccer-ownteam/SKILL.md` と既存 `ownteam_analysis_adk` へのローカルアダプターを追加する。申請されたチーム・試合・入力参照を実行側で照合し、成果物を新規の実行ディレクトリに出す。Pi に渡すのは根拠、集計結果、承認された添付に絞る。既存動画処理・検出・固定モデル工程は既存の実行プロファイルを使う。
- **契約** — `AnalysisRequest` は `skillId`、`teamId`、`gameIds`、入力参照を持つ。選手分析では明示の `playerId` を加える。 `AnalysisResult` は実行 ID、Skill・分析エンジンの版、対象範囲、成果物、根拠、未確認項目を返す。根拠には元資料の版または SHA256 と、分かる場合は映像時刻を持たせる。
- **受入** — 許可された1試合から根拠付きレポートを作成し、コーチが根拠動画へ辿れる。分母、欠落、対象外試合を区別する。Python span と OpenRouter の実モデル・費用が同じ trace で見える。無効スコープ、根拠なし、途中失敗も確認する。

## PR 4 — 敵チーム分析、選手個人分析、外部検索

| Skill | 移植対象・実行契約 | 受入 |
|---|---|---|
| `web-search` / `web-fetch` | 公開クエリを実行し、URL・取得時刻・引用箇所を返す。検索と取得は別の許可済みツールで実行 | 公式出典、公開範囲、取得失敗が追跡できる。非公開スコープから検索語が生成されても公開可能な入力だけを送る |
| `soccer-opponent` | `opponent_analysis_adk` と公開ソースの照合 | 年代・大会・シーズン・チームが合う資料を引用し、反例と対策を含める |
| `soccer-player` | `focus_player_comment` と確認済みの選手 ID／映像場面 | 選手の取り違えを止め、確認可能な映像時刻と練習課題を返す。本人未確定なら評価を保留 |

検索手段はアダプターで差し替え可能にする。OpenRouter の Web Search を使う場合は、公開クエリだけを独立した呼び出しに送る。取得 URL の再解決・リダイレクト先を検証し、ローカルアドレス、認証付き URL、他スコープを拒否する。取得本文は根拠として扱い、ツールの権限や分析の指示を変更させない。 [OpenRouter Web Search](https://openrouter.ai/docs/guides/features/server-tools/web-search)

## PR 5 — 自己改善と新規 Skill 作成

- **変更** — 失敗、コーチの修正、繰り返す未対応タスクを候補として保存する。既存 Skill の組み合わせで足りるか確認し、改善差分または新規 `SKILL.md`、ツール許可リスト、評価ケースを作る。過去の会話や外部本文を指示文へ直接転記しない。
- **評価** — チーム・試合を分けた評価データで現行版と候補版を比較する。自チームは場面と分母、敵は相手と出典、個人は本人と時刻、検索は出典と鮮度を測る。品質合格に加え費用・遅延の上限を確認する。成績の算定には人手確認、AI 参考評価、代理指標を区別して使う。
- **昇格** — 許可済みツールのみを使う宣言的な候補は、独立検証に通ればローカルで自動昇格できる。実行コード、新権限、新しい外部接続はレビューする。署名またはハッシュで版を固定し、昇格時に基準版が変わっていれば評価をやり直す。失敗で採用済み版を失わない。分析は開始時の版で完走する。
- **運用・受入** — playground の自律ランナーと steering につなぎ、STOP と試行・費用予算、失敗証跡を維持する。生成・独立評価・昇格・棄却・ロールバックを再現でき、候補の trace を元の分析に Span Link で紐づけられることを確認する。

## PR 6 — Pi と分析の導入・運用手順を完成

- **変更** — `npm install --global --ignore-scripts --install-links .` でインストールし、`doctor` で Node・OpenRouter・playground エンジン・任意の OTLP 接続を診断できるようにする。README に最短の導入例と、エラー・終了コード・成果物・設定の説明を記載する。
- **受入** — 空のユーザー設定から導入できる。外部 dotenv と playground のパスを指定すれば、実行可能な Skill と不足する依存が分かる。デフォルト設定でも既存の Pi セッションや認証状態を上書きしない。

以下は PR 6 完了時の CLI 案。現在使えるコマンドは [README](../README.md) を参照。

```sh
tactixcore-code pi --env-file /path/to/tactixcore-playground/.env --playground /path/to/tactixcore-playground
tactixcore-code run soccer-ownteam --team TEAM_ID --game GAME_ID
tactixcore-code run soccer-opponent --team TEAM_ID --game GAME_ID --opponent OPPONENT_ID
tactixcore-code run soccer-player --team TEAM_ID --game GAME_ID --player PLAYER_ID
tactixcore-code skills list
```

## 公開前に確認する範囲

PR には公開可能なソースと合成 fixture のみを含める。Git の staged 内容と公開ベースからの全コミット、npm の配布ファイル一覧を確認する。GitHub の push protection も利用する。アプリの開発時は、キー・非公開データ・ログ本文の混入をテストで検証し、必要に応じてファイル名や既知形式の検査を拡張する。 [GitHub Push Protection](https://docs.github.com/en/code-security/concepts/secret-security/push-protection)
