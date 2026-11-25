# TactixCore Code

Pi を土台とするサッカー分析ワークスペースです。このブランチで使えるのは CLI の導入と OpenRouter の接続確認です。Pi、3つの分析 Skill、外部検索、監視、自己改善の実装順と受入条件は [PR 計画](docs/pull-request-plan.md) にまとめています。

## インストール

Node.js 22.19 以上と npm が必要です。ソースを取得したら、リポジトリのルートで実行します。

```sh
npm install --global --ignore-scripts --install-links .
tactixcore-code --help
```

グローバルインストールを使わずに試す場合は、同じディレクトリで `node bin/tactixcore-code.mjs --help` を実行できます。現在の CLI に外部パッケージ依存はありません。

## OpenRouter をつなぐ

隣に `tactixcore-playground` がある場合は、その dotenv ファイルを参照できます。配置が異なる場合は `--env-file` にそのファイルの絶対パスを指定します。

```sh
tactixcore-code doctor --env-file ../tactixcore-playground/.env
tactixcore-code check-openrouter --env-file ../tactixcore-playground/.env
```

- `doctor` はキー形式だけをローカルで確認します。
- `check-openrouter` は OpenRouter 公式 API で認証を確認します。モデル推論は実行しません。出力する残り枠はキーに設定された利用上限の残りです。 [OpenRouter キー情報 API](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key)
- すでに環境変数 `OPENROUTER_API_KEY` を設定している場合は、`--env-file` を省略できます。ファイルを明示した場合はそのファイルを使います。キーはリポジトリ外に置いてください。

## 開発時の確認

```sh
npm test
npm run check:public
```

`check:public` は Git のインデックスを確認します。PR に含めるファイルをステージした後に実行してください。配布パッケージには CLI の実行ファイルと実装、npm 標準のメタデータだけを含めます。
