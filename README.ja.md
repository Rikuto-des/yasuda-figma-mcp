# yasuda-figma-mcp

[English](README.md) | **日本語**

**GitHub Codespaces** 上の **GitHub Copilot**(agent mode)向けの、自前ホスト型 **read 専用 Figma MCP サーバー**です。
スクリーンショットを**起動中の Figma アプリ内でローカル描画**(右クリック →「Copy as PNG」と同じ)し、
**公開 S3 URL には一切アップロードしません**。

> **なぜ作るか。** 公式 Figma MCP / REST の画像エンドポイントは、レンダリング結果を
> **公開・無認証の S3 URL**(`figma-alpha-api.s3...`、最大30日有効)として返します。URL を知っていれば
> 誰でもデザインを閲覧できます。セキュリティ要件の厳しい組織では受け入れられません。本サーバーはこれを
> 完全に回避します — 画像バイトは Figma クライアントのローカル `exportAsync` で生成して Copilot に直接渡す
> ため、**S3 なし・Figma REST なし・APIトークンなし・外向き HTTP も一切なし**です。

> **実機検証済み(2026-06-17):** 実 Codespace + 実 Figma デスクトップ。Copilot が 9 ツールを認識し、
> `get_screenshot` が 6576×3952 のフレームと FigJam ボードをローカル描画(S3 なし)。全ツールが
> **公開ポートなしの `gh codespace ports forward` プライベートトンネル**経由で実データを返しました。

## 仕組み

```
 手元のPC                                       あなたの Codespace
┌────────────────────┐   プライベート gh        ┌──────────────────────────┐
│ Figma デスクトップ │   トンネル(GitHub認証、 │ bridge  (:3055)          │
│  └ plugin ─ ws://localhost:3055 ════════════► │   ▲                      │
│                    │   公開ポートなし)       │ MCP ─stdio─► Copilot      │
└────────────────────┘                         └──────────────────────────┘
   exportAsync() がローカル描画 → バイトはこの経路から外に出ない
```

- **bridge**(`src/bridge.ts`)— プラグインと MCP を仲介するトークン認証付き WebSocket リレー。メッセージを転送するだけで何も永続化しない。
- **mcp**(`src/mcp.ts`)— Copilot が起動する stdio MCP サーバー。read 系ツールを公開し、localhost 経由で bridge とだけ通信。
- **plugin**(`plugin/`)— Figma アプリ内で動作し、各 read 操作を**今開いているファイル**に対して実行してデータ/バイトを返す。

プラグインは `gh codespace ports forward`(=**自分の `localhost` への GitHub 認証済みプライベートトンネル**)で Codespace の bridge に到達します。**公開ポートは一切作りません。**

> 📐 **詳細:** リクエストのライフサイクル、ワイヤープロトコル、ターゲット解決、そして各ツールが具体的にどう動くか(Figma API・入力・返り値)は **[docs/ARCHITECTURE.ja.md](docs/ARCHITECTURE.ja.md)** に記載しています。

## ツール(9個、すべて read 専用・すべてローカル)

| ツール | 返すもの | 使用 Figma API(すべてローカル) |
|---|---|---|
| `yfigma_get_screenshot` | 選択 or ノードの PNG/JPG(Copy as PNG、インライン、S3 なし) | `node.exportAsync` |
| `yfigma_get_metadata` | 軽量ノードツリー(id/name/type/座標) | ツリー走査 |
| `yfigma_get_design_context` | レイアウト/スタイル/タイポ/コンポーネント/束縛変数 | node プロパティ + `getMainComponentAsync` |
| `yfigma_get_variable_defs` | デザイントークン変数 + コレクション(モード別の値) | `variables.*` |
| `yfigma_search_design_system` | ローカルのコンポーネント/スタイルを名前検索 | `findAllWithCriteria`, `getLocal*StylesAsync` |
| `yfigma_get_libraries` | 利用可能なチームライブラリ変数コレクション | `teamLibrary.*` |
| `yfigma_get_figjam` | FigJam ボード(付箋/図形/コネクタ/テキスト) | ツリー走査 |
| `yfigma_get_document_info` | ファイル/ページ/現在ページ/選択状況 | `figma.root`, `figma.currentPage` |
| `yfigma_whoami` | 現在の Figma ユーザー + 開いているファイル | `figma.currentUser` |

`url`/`nodeId` を渡さない場合は、Figma の**現在の選択**が対象になります。

## どのプロジェクトでも使う(npx — clone も build も不要)⭐ 推奨

VS Code の**ユーザー** MCP 設定に**1回だけ**追加します(コマンドパレット → **「MCP: Open User Configuration」**)。
これで**すべての**ワークスペース/Codespace で使えます — プロジェクト毎の設定は不要:

```json
{
  "servers": {
    "yasuda-figma-mcp": {
      "command": "npx",
      "args": ["-y", "github:Rikuto-des/yasuda-figma-mcp", "mcp"],
      "env": {
        "BRIDGE_EMBED": "1",
        "BRIDGE_PORT": "3055",
        "BRIDGE_URL": "ws://127.0.0.1:3055",
        "BRIDGE_CHANNEL": "default"
      }
    }
  }
}
```

- **`BRIDGE_EMBED=1`** で MCP が **bridge をプロセス内に内蔵** — 別途 bridge を起動する必要がありません。
- **トークンは1回だけ:** **Codespaces ユーザーシークレット** `BRIDGE_TOKEN` を登録(GitHub → Settings → Codespaces → Secrets、使うリポジトリに許可)。全 Codespace に自動で注入されます。(ローカル VS Code の場合は上の `env` に `"BRIDGE_TOKEN": "<トークン>"` を直接書く。)値は `openssl rand -hex 24` で生成。
- まっさらな Codespace での初回起動時に1回だけビルドします(約30〜60秒、以降キャッシュ)。

**セッション毎**(どのプロジェクトでも): Codespace を開く → ローカルでトンネルを張る → Figma プラグインを実行して Connect:

```bash
# 手元のマシンで、対象プロジェクトの Codespace を指して:
npx -y github:Rikuto-des/yasuda-figma-mcp tunnel
# または:  gh codespace ports forward 3055:3055 -c <codespace名>
```

プロジェクト毎にやるのは**トンネル + プラグイン Connect だけ**。ツール(ユーザー設定)もトークン(ユーザーシークレット)も bridge(内蔵)も最初から揃っています。

## このリポジトリを clone して使う(代替手段)

1. **このリポで Codespace を作成**(Code → Codespaces → Create)。devcontainer が `npm install && npm run build && npm run setup` を実行し、**個人用トークンを自動生成**して `.env` に書き込みます。
2. Codespace のターミナルで **bridge 起動**:
   ```bash
   npm run bridge        # [bridge] listening on 0.0.0.0:3055 が出る
   ```
3. **手元のマシン**でトンネルを張る(`gh` に `codespace` スコープが必要 — 初回のみ `gh auth refresh -s codespace`):
   ```bash
   gh codespace ports forward 3055:3055 -c <あなたのcodespace名>
   # (ローカルに clone があれば:  npm run tunnel )
   ```
4. **Figma デスクトップ**でプラグインを実行(入手方法は下記)→ トークンを貼る → **Connect**(トークンは `npm run setup` が表示。再実行 or `grep BRIDGE_TOKEN .env` で再確認可)。
5. **Copilot**(agent mode)で利用。MCP は自動起動し 9 ツールを認識(トークン入力なし)。例: *「今の Figma の選択をスクショして」*。

### 2回目以降(resume)

Codespace はアイドルで自動停止します。再開手順: Codespace を開き直す → `npm run bridge` → トンネル → プラグイン実行 → Connect。トークンは `.env` に保持されます。

## プラグインの入手

**推奨 — 組織限定プラグインとして1回公開**(Figma Organization/Enterprise):

1. Figma デスクトップ: **Plugins → Development → Import plugin from manifest…** → `plugin/manifest.json` を選択(管理者が1回)。
2. **Plugins → Development → Manage plugins in development →** *Yasuda Figma MCP* → **Publish**。
3. 公開範囲を **「Only available to your organization」** にし、名前/説明とアイコン(`plugin/icon.svg` を 128×128 PNG に書き出し)を設定して公開。
4. メンバーは **Plugins →(組織のプラグイン)** から実行 — manifest import 不要。更新は再 Publish。

**代替 — manifest import(どの Figma プランでも):** 各自が `plugin/manifest.json` を *Plugins → Development → Import plugin from manifest…* で取り込む(Figma デスクトップ必須。ブラウザ版は開発プラグインを取り込めない)。

## トークン(ユーザー毎)— `.env` か Codespaces シークレット

トークンは**ユーザー毎に自動生成**。どちらの方式でも Copilot 側の入力は不要(MCP が環境変数から読む):

- **`.env`(既定):** `npm run setup` がトークンを生成して `.env`(gitignore 済み)に書き込む。`npm run bridge` と MCP が `--env-file-if-exists` で読み込む。
- **Codespaces シークレット:** ユーザーシークレット **`BRIDGE_TOKEN`** を登録(GitHub → Settings → Codespaces → Secrets、または `gh secret set BRIDGE_TOKEN --user`)。`npm run setup` は検知して `.env` を触らず、bridge と MCP は環境変数から読む。

いずれの場合も、同じ値を Figma プラグインに1回貼り付けます(`npm run setup` が表示)。ローテーション: `rm .env && npm run setup`。

## セキュリティモデル

- **公開ポートなし。** bridge は自分の `localhost` への GitHub 認証済みプライベート `gh` トンネル経由でのみ到達可能。インターネットには一切露出しません。
- **S3 なし・Figma REST なし・トークンなし・外向き HTTP なし。** 画像はローカル `exportAsync`、その他のデータは Figma プラグイン API から。(リポを `grep` しても `fetch` も `api.figma.com` も `/v1/images` も無い。)
- **多層防御。** プライベートトンネル(誰がポートに到達できるか)+ ユーザー毎 `BRIDGE_TOKEN`(誰がチャンネルに入れるか)+ プラグインの `networkAccess` を `ws://localhost:3055` に限定。bridge は何も永続化しない。
- トンネル(または Codespace)を止めれば経路は消えます。

## 制約(正直な注記)

- **今開いているファイルのみ** — プラグインなので、表示していないファイルには到達不可(公式 MCP/REST は file key で任意ファイルを取得可能)。
- **`get_design_context` は生のデザインデータを返す** — Figma のコード生成そのものではなく、コード化は LLM 側。
- **`get_libraries`** はチームライブラリの**変数**コレクションのみ(プラグイン API の制約)。コンポーネントライブラリの完全列挙は不可。
- **Code Connect は対象外**(プラグイン API から到達不可)。

## スクリプト

| コマンド | 内容 |
|---|---|
| `npm run setup` | トークンを生成/再利用(`.env` or Codespaces シークレット)して表示 |
| `npm run build` | TypeScript を `dist/` にビルド |
| `npm run bridge` | bridge 起動(`.env` を自動ロード) |
| `npm run tunnel` | 手元からプライベートトンネルを張る(Codespace を自動検出) |
| `npm run mcp` | MCP を手動起動(通常は Copilot が自動起動) |

## トラブルシュート

- **「Figma plugin is not connected」** — プラグインを実行して Connect 済みか、トークン/URL/チャンネルが一致するか確認。bridge ログに `plugin joined` が出るはず。
- **「Bridge is not connected」** — Codespace で `npm run bridge` が動いているか、`BRIDGE_TOKEN` が設定済みか(`npm run setup`)。
- **プラグインが繋がらない** — ローカルで `gh codespace ports forward 3055:3055` が動いているか、プラグインの URL が `ws://localhost:3055` か。トンネルが切れたら張り直す。
- **プラグインが点滅(join/leave ループ)** — プラグインが2つ起動している(別ファイルで2つ等)。1つだけにする。
- **Copilot に画像が出ない** — 画像対応(vision)モデルを使う。`yfigma_get_screenshot` は `saveToFile: true` で Codespace 内に PNG 保存も可能(S3 不使用)。

## コントリビュート

Issue / PR 歓迎。bridge/MCP は小さな TypeScript(`src/`)、プラグインは素の JS(`plugin/`)。`npm run build` が通ることが条件です。

## ライセンス

[MIT](LICENSE) © 2026 Rikuto Yasuda
