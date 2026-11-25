# TactixCore Code

Pi からサッカー分析の手順を相談し、playground の分析エンジンを CLI から実行するワークスペースです。実装順と受入条件は [PR 計画](docs/pull-request-plan.md) を参照してください。

## インストール

Node.js 22.19 以上と npm を用意し、このリポジトリのルートで実行します。

```sh
npm ci --ignore-scripts
node bin/tactixcore-code.mjs --help
```

どのディレクトリからでも `tactixcore-code` で起動するには、同じリポジトリのルートで次を実行します。

```sh
npm install --global --ignore-scripts --install-links .
command -v tactixcore-code
tactixcore-code --help
```

インストール後に zsh でコマンドが見つからない場合は、`rehash` を実行してから再確認します。まだ見つからない場合は、`npm prefix --global` が返すディレクトリの `bin` が PATH に含まれているか確認してください。

## Pi の対話画面を開く

初回だけ OpenRouter キーが入った外部 dotenv の場所を登録します。その後は、編集したいプロジェクトのディレクトリで起動します。

```sh
tactixcore-code configure --env-file /path/to/tactixcore-playground/.env
tactixcore-code
```

Pi の画面で普通に入力すると、同じ会話のまま続けられます。組み込み Skill は `/skill:` で選べます。コーディング用ツールは起動ディレクトリ内の閲覧・編集・作成に使えます。モデルにはシェル実行を公開していません。終了は空の入力欄で Ctrl+D、または `/quit` です。

設定ファイルに保存するのは dotenv のパスです。OpenRouter キーは起動のたびに元ファイルから読みます。1回だけ別の設定を使う場合は `tactixcore-code --env-file PATH` を使えます。

## OpenRouter と Pi

`--env-file` にリポジトリ外の dotenv を指定すると、`OPENROUTER_API_KEY` を実行時に読みます。すでに環境変数を設定している場合は省略できます。ファイルを明示した場合は、そのファイルを使います。

```sh
tactixcore-code doctor --env-file ../tactixcore-playground/.env
tactixcore-code check-openrouter --env-file ../tactixcore-playground/.env
tactixcore-code pi --env-file ../tactixcore-playground/.env \
  --prompt '守備の振り返りで確認する観点を3つ挙げて'
```

- `doctor` はキーの形式をローカルで確認します。
- `check-openrouter` は認証とキーの残り利用上限を照会します。モデル推論なしで確認できます。 [OpenRouter キー情報 API](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key)
- `pi` はワンショットの対話です。既定の `agentrouter/auto` は OpenRouter の `openrouter/auto` に解決します。既定の `triage` では軽量モデルを候補にします。固定モデルを試す場合は `--model openai/gpt-5-nano`、戦術統合向けには `--stage synthesis` を指定できます。Pi の既存設定や対話履歴は使いません。 [OpenRouter Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router)

```sh
tactixcore-code skills list
tactixcore-code skills show soccer-ownteam
tactixcore-code pi --env-file ../tactixcore-playground/.env \
  --skill soccer-ownteam --prompt '試合の分析に用意すべき入力は？'
```

`pi --skill` は組み込み Skill の手順を会話に追加します。分析の実処理は以下の `run` または `pi --analysis-input` で開始できます。Pi に送る依頼文には、OpenRouter に送信可能な内容だけを入力してください。

## 実試合の分析

```sh
export TACTIXCORE_PLAYGROUND=/path/to/tactixcore-playground
tactixcore-code run soccer-ownteam --team TEAM_ID --game GAME_ID --input ownteam.json --dry-run
tactixcore-code run soccer-ownteam --team TEAM_ID --game GAME_ID --input ownteam.json
tactixcore-code run soccer-opponent --team TEAM_ID --game GAME_ID --opponent OPPONENT_ID --input opponent.json
tactixcore-code run soccer-player --team TEAM_ID --game GAME_ID --player PLAYER_ID --input player.json
tactixcore-code pi --env-file "$TACTIXCORE_PLAYGROUND/.env" --skill soccer-ownteam \
  --team TEAM_ID --game GAME_ID --analysis-input ownteam.json --prompt '指定の試合を分析して'
```

`--input` は playground 内の JSON ファイルです。各 JSON の必須項目は [分析入力と成果物](docs/analysis-inputs.md) を参照してください。 `--dry-run` は入力、対象範囲、Python 環境を確認します。実行時は既存エンジン側で設定したモデルと認証を使います。OpenRouter のキーは分析子プロセスに継承しません。選手 Skill の強調トラックはコーチの本人確認が必要です。

`pi --analysis-input` では、チーム・試合・入力を検証した後に Pi へスコープ固定のツールを1つだけ渡します。ツールはその分析を1回実行できます。OpenRouter に返すのは成功・失敗の状態で、レポートと根拠はローカルに残ります。

## 公開情報の検索

```sh
tactixcore-code web-search --env-file ../tactixcore-playground/.env --query 'JFA U-18 プレミアリーグ 公式日程'
tactixcore-code web-fetch --url 'https://www.jfa.jp/'
```

検索は公開クエリの引用候補を返します。ページを取得して、対象チームや年度を照合してください。 `web-fetch` は HTTPS のテキストまたは HTML の抜粋を返します。認証付き URL、プライベートネットワーク、リダイレクトを含むページは拒否します。 [OpenRouter Web 検索](https://openrouter.ai/docs/guides/features/plugins/web-search)

## テレメトリーと改善候補

`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces` を設定すると、OTLP/HTTP JSON でトレースを送れます。Pi の推論では要求モデル、実モデル、取得できたルーティング情報、トークン、費用を記録します。検索クエリ、依頼本文、非公開ファイルパス、キーは属性に含めません。分析では子プロセスに `TRACEPARENT` を渡します。Python 側の工程別 span にはエンジン側の計装が必要です。

```sh
tactixcore-code improve status --playground "$TACTIXCORE_PLAYGROUND"
tactixcore-code improve scan --playground "$TACTIXCORE_PLAYGROUND" --observations /path/to/reviewed-observations.json
```

`scan` は確認済みの構造化観察から候補を保存します。異なる3回以上のトレースで同じ所見が確認された場合に、組み込み Skill の更新案か根拠点検 Skill の新規案を出します。独立評価と昇格は今後の作業です。既存ランナーの STOP は `status` に表示し、CLI はランナーを起動・再開しません。 [観察の形式](docs/analysis-inputs.md#改善候補の観察入力)

## 開発時の確認

```sh
npm test
npm run check:public
```

`check:public` はステージ済みのパスと既知の資格情報形式を確認します。配布には CLI 実装、組み込み Skills、npm 標準のメタデータを含めます。機密情報はリポジトリ外で管理してください。
