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

## セットアップ ⭐ 推奨(npx + Codespaces シークレット)

clone も build もプロジェクト毎の設定も不要。**初回セットアップ**を1回やれば、以降は各プロジェクトで**トンネル + Connect だけ**です。

### 初回セットアップ(開発者ごとに1回)

**1 — トークンを生成**(任意のランダムな秘密文字列。bridge チャンネルの合言葉):

```bash
openssl rand -hex 24
# → 出力をコピー(例 7f3a9c4e…)。手順2とプラグインで使う
```

**2 — Codespaces ユーザーシークレットに登録**(*推奨 — 全 Codespace で1つの値、プロジェクト毎の管理が不要*):

- GitHub → **Settings → Codespaces → Secrets** → **New secret**
  - **Name:** `BRIDGE_TOKEN`
  - **Value:** 手順1のトークン
  - **Repository access:** 使うリポジトリ(または *All repositories*)
- …または CLI: `gh secret set BRIDGE_TOKEN --user --app codespaces`(プロンプトに値を貼る)

以降、開く Codespace すべてに `$BRIDGE_TOKEN` が自動注入され、MCP と内蔵 bridge が**プロンプトなし**で読みます。

**3 — VS Code の*ユーザー*設定に MCP サーバーを追加**(1回。全ワークスペース/Codespace に適用):

- コマンドパレット → **「MCP: Open User Configuration」**
- 以下を貼って保存:

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

`BRIDGE_EMBED=1` で MCP が **bridge をプロセス内に内蔵**するため、別途 bridge 起動は不要。(ローカル VS Code でシークレット未使用なら、この `env` に `"BRIDGE_TOKEN": "<トークン>"` を直接書く。)

> **Codespaces 注意:** ユーザー設定が Codespace に届くのは VS Code の **Settings Sync** が ON のときだけ。確実なのは、**同じ `{ "servers": { … } }` を各リポの `.vscode/mcp.json` にコミット**する方法 — そのリポの Codespace を開けば必ず存在します。(`.github/` でも `devcontainer.json` でもありません。あれらは MCP サーバーを定義しません。)

**4 — ローカルの `gh` に `codespace` スコープを付与**(トンネルに必要。1回):

```bash
gh auth refresh -h github.com -s codespace
```

**5 — Figma プラグインを入手**(1回) — [プラグインの入手](#プラグインの入手) 参照。推奨は**組織限定公開**(全員のプラグイン一覧に出て manifest import 不要)。

### セッション毎(各プロジェクト、毎回)

> **順番が大事** — トンネルが繋がる前に、**Codespace 内で bridge が `:3055` を待ち受けている**必要があります:
> **(1) Codespace で bridge を起動 → (2) 自分のPCからトンネル → (3) プラグイン Connect。**

**1 — 対象プロジェクトの Codespace を開き、`:3055` で bridge が待受しているか確認。** MCP を設定済み(上記)＋ `BRIDGE_EMBED=1` なら、MCP の初回ロード時に Copilot が MCP を起動 → 内蔵 bridge が立ちます(Copilot Chat を **agent** モードで開く、または **「MCP: List Servers」→ Start**)。まっさらな Codespace は初回だけ1回ビルド(約30〜60秒)。

> 確実な方法(かつ動作確認用):**Codespace のターミナル**で明示的に起動して開いたままにする:
> ```bash
> echo "$BRIDGE_TOKEN"                                   # 空でないこと
> npx -y github:Rikuto-des/yasuda-figma-mcp bridge       # → [bridge] listening on 0.0.0.0:3055
> ```

**2 — トンネルは「自分のPCのターミナル」で張る — Codespace のターミナルではない。** 自分のPCの `localhost:3055` を Codespace に繋ぎ、Figma デスクトップから到達できるようにします:

```bash
gh codespace list                                # Codespace 名を調べる
gh codespace ports forward 3055:3055 -c <名前>   # 開いたまま放置
# (このリポのローカル clone があれば:  npm run tunnel)
```

> ここで `connect failed (Connection refused)` = Codespace の `:3055` でまだ誰も待ち受けていない → 手順1へ。
> `No Codespace found` = **Codespace の中**で実行している → 自分のPCで実行する。

**3 — Figma プラグイン**(「Yasuda Figma MCP」)を自分のPCで実行。保存済み設定で**自動接続**します(初回はトークンを貼る — Codespace ターミナルで `echo "$BRIDGE_TOKEN"` で表示)。ステータスが **Ready** に。

**4 — Copilot**(agent mode)で利用。例: *「今の Figma の選択をスクショして」*。9 個の `yfigma_*` ツールが使えます。

プロジェクト毎にやるのは**bridge 起動 → トンネル → プラグイン Connect**だけです。

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

## トークン(ユーザー毎)

トークンは**bridge チャンネルに誰が入れるか**を制御するランダムな秘密です(プライベートトンネルに加えた多層防御)。どちらの方式も Copilot 側の入力は不要 — MCP が環境変数 `BRIDGE_TOKEN` を読みます。

- **Codespaces ユーザーシークレット — 推奨 ✅** — 1つの値を1回登録すれば、全リポの**すべての** Codespace に継承され、プロジェクト毎の管理が不要。GitHub → **Settings → Codespaces → Secrets → `BRIDGE_TOKEN`**(または `gh secret set BRIDGE_TOKEN --user --app codespaces`)。Codespace で表示: `echo "$BRIDGE_TOKEN"`。
- **`.env` — Codespace 毎の代替** — clone 方式で使用。`npm run setup` がトークンを生成して `.env`(gitignore 済み)に書き、`npm run bridge` と MCP が `--env-file-if-exists` で読む。ローテーション: `rm .env && npm run setup`。

同じ値を Figma プラグインに1回貼り付けます。シークレットと一致する `.env` が両方あれば、シークレット(プロセス環境)が優先されます。

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

- **`No Codespace found`(`tunnel` 実行時)** — **Codespace の中**で実行しています。トンネルは**自分のPCのターミナル**で(自分の localhost を Codespace に繋ぐもの)。`gh codespace list` も自分のPCで。
- **トンネルで `connect failed (Connection refused)`** — トンネルは正常だが、**Codespace の `:3055` で誰も待ち受けていない**。Codespace 側で bridge を起動: Copilot を開いて MCP を起動(内蔵bridge)するか、Codespace ターミナルで `npx -y github:Rikuto-des/yasuda-figma-mcp bridge`。その後トンネルを張り直す。
- **Codespace で `echo "$BRIDGE_TOKEN"` が空** — シークレットが来ていない。Codespace 作成**後**に足したシークレットは **Rebuild / 開き直し**で初めて反映(急ぎは `export BRIDGE_TOKEN=…` で一時設定)。
- **「Figma plugin is not connected」** — プラグインを実行して Connect 済みか、トークン/URL/チャンネルが一致するか確認。bridge ログに `plugin joined` が出るはず。
- **「Bridge is not connected」** — Codespace で bridge(または Copilot の MCP)が動いているか、`BRIDGE_TOKEN` が設定済みか。
- **プラグインが繋がらない** — **自分のPC**で `gh codespace ports forward 3055:3055` が動いているか、プラグインの URL が `ws://localhost:3055` か。トンネルが切れたら張り直す。
- **接続が断続的に落ちる** — プラグイン↔bridge は `gh` トンネルを跨ぐので、(a) プラグインは20秒ごとに keepalive を送り、bridge は pong の1回取りこぼしを許容(最新のプラグイン+パッケージが必要)、(b) **bridge を内蔵ではなく独立常駐**にする、の2点が効く。`BRIDGE_EMBED=1` だと、Copilot がアイドルで MCP を停止/再起動するたびに bridge も落ち、プラグインが切れる。対策: mcp.json の `env` から `BRIDGE_EMBED` を外し、Codespace のターミナルで `npx -y github:Rikuto-des/yasuda-figma-mcp bridge` を開いたまま常駐させる。MCP は localhost で即再接続するだけで、プラグインのトンネル接続には影響しない。加えてトンネルが生きているか・Codespace がアイドル停止していないかも確認。
- **複数ページ vs 複数ファイル** — 同一ファイル内の**ページ切替**は何も不要(プラグインは接続維持で現在ページに追従。別ページは `nodeId`/`url` 指定、検索は `allPages:true`)。**ファイル切替**ではプラグインが閉じる(Figma の仕様)ので再実行するだけ — 保存済みトークンで**自動接続**します。複数ファイルで同時に開いた場合は最後に接続したものが有効になり、他はアイドルに(点滅は解消)。
- **Copilot に画像が出ない** — 画像対応(vision)モデルを使う。`yfigma_get_screenshot` は `saveToFile: true` で Codespace 内に PNG 保存も可能(S3 不使用)。

## コントリビュート

Issue / PR 歓迎。bridge/MCP は小さな TypeScript(`src/`)、プラグインは素の JS(`plugin/`)。`npm run build` が通ることが条件です。

## ライセンス

[MIT](LICENSE) © 2026 Rikuto Yasuda
