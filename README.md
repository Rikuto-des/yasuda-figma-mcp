# figma-secure-screenshot

公式 Figma MCP の **read 系ツール相当**を、**公開 S3 を一切経由せず**に提供する自前 MCP サーバーです。
GitHub Codespaces 内で動かし、**GitHub Copilot(agent mode)** から利用することを想定しています。

## なぜ作るか

公式 Figma MCP / REST API の画像取得は、レンダリング結果を
`figma-alpha-api.s3.us-west-2.amazonaws.com` 上の **公開・無認証・最大30日有効** な
オブジェクトとして返します。URL を知っていれば誰でも画像を閲覧でき、機密デザインの
漏洩リスクになります。

このプロジェクトは、Figma の右クリック **「Copy as PNG」と同じローカル描画**
(`node.exportAsync`)を使います。画像バイトは**あなたの Figma アプリ内で生成**され、
S3 にも外部サービスにも上がりません。メタデータ・変数・デザインコンテキストなどの
read 系も、すべて Figma プラグイン API でローカル取得します。

## アーキテクチャ

```
ローカルPC                                         Codespace
┌──────────────────┐   gh の認証トンネル          ┌───────────────────────┐
│ Figma プラグイン │   (公開なし・GitHub 認証)    │ ブリッジ :3055         │
│ exportAsync()→   │   ws://localhost:3055        │   ↑                   │
│ ローカル描画      │ ════════════════════════════>│ MCP(ws://127.0.0.1)→  │
│ (S3 なし)        │                              │   stdio → Copilot     │
└──────────────────┘                              └───────────────────────┘
```

**公開ポートは使いません。** `gh codespace ports forward 3055:3055` が Codespace の 3055 番を
あなたのローカルの `localhost:3055` に**プライベート(GitHub 認証)**で繋ぎます。
プラグインは `ws://localhost:3055` に接続するだけ。外部に晒される URL は存在しません。

- **bridge**（`src/bridge.ts`）: プラグインと MCP を仲介する WebSocket リレー。トークン認証のみ行い、ペイロードは保存せず素通し。
- **mcp**（`src/mcp.ts`）: stdio で Copilot に繋がる MCP サーバー。read 系ツールを公開し、各操作をブリッジ経由でプラグインに依頼。
- **plugin**（`plugin/`）: Figma 内で動き、ローカルで描画・データ取得して返す。

## 提供ツール（公式 read 系との対応）

| ツール | 内容 | 公式相当 |
|---|---|---|
| `figma_get_screenshot` | 選択 or 指定ノードを PNG/JPG でローカル描画（Copy as PNG 相当）。画像はインライン返却 | `get_screenshot` |
| `figma_get_metadata` | ノードツリーの軽量版（id/name/type/座標/サイズ） | `get_metadata` |
| `figma_get_design_context` | 実装用の深い直列化（レイアウト/スタイル/タイポ/テキスト/コンポーネント/束縛変数） | `get_design_context` |
| `figma_get_variable_defs` | デザイントークン変数（モード別の値つき）と所属コレクション | `get_variable_defs` |
| `figma_search_design_system` | コンポーネント/スタイルを名前で検索 | `search_design_system` |
| `figma_get_libraries` | 利用可能なチームライブラリ変数コレクション（※制約あり） | `get_libraries` |
| `figma_get_code_connect_map` | コンポーネントの key 一覧（※ベストエフォート） | `get_code_connect_map` |
| `figma_get_figjam` | FigJam ボードの直列化 | `get_figjam` |
| `figma_get_document_info` | ファイル/ページ/選択状況 | （補助） |
| `figma_whoami` | 現在の Figma ユーザーと開いているファイル | `whoami` |

### 制約（正直な注記）

- **`figma_get_design_context`** は Figma のコード生成そのものを再現するのではなく、**LLM がコード化するための生のデザインデータ**を返します。Copilot 側でコードを生成してください。
- **`figma_get_libraries`** はプラグイン API の制約で、チームライブラリの **変数コレクション**しか列挙できません。コンポーネントライブラリの完全な列挙は不可。
- **Code Connect** の完全なマッピングは Figma のクラウドサービス側にあり、プラグイン API からは取得できません。`figma_get_code_connect_map` は join 用の key 一覧までです。

## セットアップ

### 1. 依存インストールとビルド

```bash
npm install
npm run build
```

### 2. トークンを生成して `.env` を用意

```bash
cp .env.example .env
npm run token   # 出力された値を .env の BRIDGE_TOKEN に貼る
```

`BRIDGE_TOKEN` はブリッジ・MCP・プラグインで**同じ値**を使います。パスワード相当として扱ってください。

### 3. Codespace でブリッジを起動

```bash
npm run bridge   # Codespace 内で :3055 を待ち受け
```

### 3-2. ローカルからプライベートトンネルを張る（公開なし）

**自分のローカル PC のターミナル**で、Codespace の 3055 番を localhost に転送します:

```bash
gh codespace ports forward 3055:3055 -c <CODESPACE_NAME>
# 一覧は: gh codespace list
```

これは GitHub 認証済みの**プライベート**トンネルで、公開 URL は作られません。
これでローカルの `ws://localhost:3055` が Codespace のブリッジに繋がります。
（このコマンドは Figma を使う間つけっぱなしにします。）

### 4. Copilot に MCP を登録

`.vscode/mcp.json` を同梱済みです。VS Code（Codespaces）の Copilot agent mode が
`dist/mcp.js` を stdio で起動し、`ws://127.0.0.1:3055`（同一 Codespace 内）でブリッジに繋ぎます。
起動時に `BRIDGE_TOKEN` を聞かれるので、`.env` と同じ値を入力してください。

> MCP サーバー自身は公開ポートに触れません。公開転送を越えるのは「プラグイン↔ブリッジ」の一区間だけです。

### 5. Figma にプラグインを読み込んで接続

1. Figma デスクトップ → メニュー → Plugins → Development → **Import plugin from manifest…**
2. `plugin/manifest.json` を選択。
3. 対象ファイルを開いた状態でプラグインを実行。
4. UI の **Bridge URL** は既定の `ws://localhost:3055` のまま、**Token / Channel** を入力し **Connect**。
5. ステータスが **Ready** になり、Copilot 側のツールが使えるようになります。

## 使い方の例（Copilot）

- レイヤーを選択して: 「選択中の Figma ノードのスクリーンショットを取って」
- 「この Figma URL のデザインコンテキストを取得して実装して」（URL の `node-id` を自動解決）
- 「このコンポーネントが使っているデザイントークン変数を一覧して」

`url` か `nodeId` を渡さない場合は **Figma の現在の選択**が対象になります（Copy as PNG と同じ感覚）。

## セキュリティモデル

- **公開ポートなし。** ブリッジは Codespace 内に閉じ、`gh codespace ports forward` の
  **GitHub 認証済みプライベートトンネル**経由でしか到達できません。インターネットに晒される
  URL は一切作りません。
- **画像は S3 に上がらない。** `figma_get_screenshot` は Figma クライアント内の `exportAsync`
  （= Copy as PNG）でローカル描画し、バイト列を直接返します。Figma の公開 S3 は経由しません。
- **多層防御:** プライベートトンネル（GitHub 認証）＋ 共有トークン（チャンネル参加に必須）＋
  loopback のみ（`networkAccess` は localhost に限定）。ペイロードはブリッジを素通りするだけで永続化しません。
- トークンが漏れたら `npm run token` で再生成し、ブリッジ・MCP・プラグインの3者を更新します。
- 使わないときはトンネル（`gh ... forward`）を止めれば、ローカルからの到達経路も消えます。

## スクリプト

| コマンド | 説明 |
|---|---|
| `npm run build` | TypeScript をビルド |
| `npm run bridge` | ブリッジ起動（要 `BRIDGE_TOKEN`） |
| `npm run mcp` | MCP を手動起動（通常は Copilot が自動起動） |
| `npm run dev:bridge` | tsx でブリッジをホットリロード |
| `npm run token` | ランダムトークン生成 |

## トラブルシュート

- **「Figma plugin is not connected」**: プラグインの UI で Connect 済みか、URL/Token/Channel が一致するか確認。
- **「Bridge is not connected」**: Codespace で `npm run bridge` が起動しているか、`BRIDGE_URL`（既定 `ws://127.0.0.1:3055`）が合っているか確認。
- **プラグインが繋がらない**: ローカルで `gh codespace ports forward 3055:3055` が動いているか、プラグインの URL が `ws://localhost:3055` か、トークン/チャンネルが一致しているか確認。トンネルが切れたら張り直す。
- **画像が Copilot に表示されない**: Copilot のモデルが画像（vision）対応か確認。`saveToFile: true` で Codespace 内にも保存できます（S3 不使用）。
