# アーキテクチャと各ツールの動作

[English](ARCHITECTURE.md) | [日本語](ARCHITECTURE.ja.md)

このドキュメントは、エンドツーエンドのデータフロー、ワイヤープロトコル、そして
9 ツールそれぞれの正確な挙動(どの Figma API を呼ぶか・入力・返り値)を説明します。

## コンポーネント

| プロセス | ファイル | 役割 | ネットワーク |
|---|---|---|---|
| **MCP サーバー** | `src/mcp.ts` | Copilot が起動する stdio サーバー。9 ツールを公開し、request/response を対応付ける | `ws://127.0.0.1:3055` で bridge に接続 |
| **bridge** | `src/bridge-core.ts`(`bridge.ts` / `mcp.ts` に内蔵) | トークン認証付き WebSocket リレー。チャンネル毎に `mcp` 1つと `plugin` 1つをペアリング | `:3055` の WS サーバー |
| **プラグイン — UI iframe** | `plugin/ui.html` | WebSocket を保持。base64 変換。メインスレッドと相互中継 | WebSocket(Figma メインスレッドは**ネットワーク不可**) |
| **プラグイン — メインスレッド** | `plugin/code.js` | **開いているドキュメント**に対して read 操作を Figma プラグイン API で実行 | なし |

## リクエストのライフサイクル

すべてのツール呼び出しは、同じ経路を1往復します:

```
Copilot ──tools/call──► MCP (src/mcp.ts)
                          │  ターゲット解決 + デフォルト補完
                          ▼
                        bridge.request({op, params})           ws://127.0.0.1:3055
                          │  {type:"request", requestId, op, params}
                          ▼
                        BRIDGE (中継)  ──同一チャンネル──►  PLUGIN UI (ui.html)
                                                              │ postMessage
                                                              ▼
                                                            PLUGIN MAIN (code.js)
                                                              │ handleRequest(op, params)
                                                              │ → 開いているドキュメントに Figma API
                                                              ▼
                                                            {type:"response", requestId, ok, result}
                          ◄───────────────── 中継 ────────────┘
                        BridgeClient が requestId を照合 → Promise を解決
                          │  整形: 画像 → インライン image ブロック / それ以外 → 整形JSON
                          ▼
Copilot ◄──CallToolResult──
```

1. Copilot が `tools/call`(stdio 上の JSON-RPC)を MCP サーバーに送る。
2. ツールハンドラが**ターゲット**(後述)を解決しデフォルトを補完して `bridge.request(op, params)` を呼ぶ。
3. `BridgeClient` が `{type:"request", requestId, op, params}` を bridge に送る。
4. bridge は同一チャンネルの plugin にそのまま中継。**plugin 未接続なら即座に** `{ok:false, error:"Figma plugin is not connected…"}` を返す。
5. プラグインの **UI iframe** が受け取り、`postMessage` で**メインスレッド**へ渡す。
6. `code.js` の `handleRequest(op, params)` が op ハンドラへ振り分け、開いているドキュメントに Figma プラグイン API を実行。
7. ハンドラの結果を UI へ返し、UI が `{type:"response", requestId, ok, result}` を WebSocket で送る。
8. bridge が MCP へ中継。`BridgeClient` が `requestId` を照合し pending Promise を解決。
9. MCP が結果を整形 — **スクショ → インライン `image` ブロック**、その他 → 整形 JSON テキスト — して Copilot に返す。

### なぜプラグインは2スレッドに分かれるか

Figma プラグインの**メインスレッド**(`code.js`)はドキュメントを読めますが**ネットワーク不可**です。**UI iframe**(`ui.html`)は WebSocket/`fetch`/`btoa` を持つ一方でドキュメント API を持ちません。そのため WebSocket は UI に、Figma API 呼び出しはメインスレッドに置き、`postMessage` で受け渡します。画像バイトはメインスレッドで `figma.base64Encode` し、UI がソケットで送ります。

## ワイヤープロトコル(bridge 上)

素の JSON テキストフレーム。bridge は共有トークンで認証し、同一チャンネルの `mcp` と `plugin` をペアリングし、それ以外はそのまま中継します(中身は一切見ない)。

| メッセージ | 方向 | 形 |
|---|---|---|
| `join` | client → bridge | `{type:"join", role:"mcp"\|"plugin", channel, token}` |
| `request` | mcp → plugin | `{type:"request", requestId, op, params}` |
| `response` | plugin → mcp | `{type:"response", requestId, ok, result?, error?}` |
| `system` | bridge → client | `{type:"system", event:"joined"\|"peer_connected"\|"peer_disconnected"\|"error", message?}` |

MCP の**ツール名**(`yfigma_*`)はクライアント向け、**op**(`screenshot`, `metadata`, …)はプラグインが分岐する内部の動詞で、意図的に分離しています。

## ターゲット解決

多くのツールはノードか現在の選択を対象にします。MCP は引数から `target` を組み立てます:

- `nodeId` 指定、または Figma `url`(`?node-id=1-23` → `1:23`)から解析 → `{kind:"node", nodeId}` → プラグインは `figma.getNodeByIdAsync(nodeId)`。
- それ以外 → `{kind:"selection"}` → プラグインは `figma.currentPage.selection`(未選択ならエラー)。

プラグインは**今開いているファイル**しか見られません — これが REST ベースの公式 MCP との本質的なトレードオフです。

## 9 つのツール

> 入力 `url?` / `nodeId?` は上記ターゲットの省略形。返り値は注記がなければ JSON。

### `yfigma_get_screenshot` — op `screenshot`
- **入力:** `url?`, `nodeId?`, `scale`(1–4、既定 2), `format`(`PNG`|`JPG`、既定 PNG), `saveToFile?`。
- **動作:** 対象ノードごとに `node.exportAsync({ format, constraint: { type: "SCALE", value: scale } })` → `Uint8Array` → `figma.base64Encode`。右クリック →「Copy as PNG」と同じエンジン。
- **返り値:** ノードごとに**インライン `image` ブロック**1つ(+ テキスト行 `name (id) — 幅x高さ`)。`saveToFile:true` で `FIGMA_EXPORT_DIR`(既定 `.figma-exports/`、gitignore 済み)に PNG も保存しパスを返す。
- **注記:** S3 も URL もなし、生バイトのみ。複数選択 → 複数画像。

### `yfigma_get_metadata` — op `metadata`
- **入力:** `url?`, `nodeId?`, `depth?`(0–20、既定 6)。
- **動作:** 軽量な再帰走査(`metaNode`): `id, name, type, visible, x, y, width, height` と `depth` までの `children[]`(それ以深は `childCount`)。
- **返り値:** `{ count, nodes:[…] }`。
- **用途:** 重い取得の前に、ノード id/構造を安く把握する。

### `yfigma_get_design_context` — op `design_context`
- **入力:** `url?`, `nodeId?`, `depth?`(0–12、既定 4)。
- **動作:** 深い直列化(`ctxNode`): bounds/size、opacity、rotation、constraints、**オートレイアウト**(`layoutMode`、整列、サイジング、wrap、`itemSpacing`、padding)、`layoutSizing`、**fills**(hex)、**strokes**(+ weight/align)、**effects**(影/ブラー)、角丸、**text**(characters、font、size、line-height、整列、case、decoration)、**component**(インスタンス → メインコンポーネントの key/name + `componentProperties`、コンポーネント/セット → key + 説明)、**束縛変数**(名前に解決)、children。
- **返り値:** `{ count, nodes:[…] }`。
- **注記:** モデルがコード化するための生データで、Figma のコード生成出力**ではない**。`figma.mixed` は `"mixed"` として返す。

### `yfigma_get_variable_defs` — op `variable_defs`
- **入力:** `url?`, `nodeId?`, `scope`(`target`|`all`、既定 `target`)。
- **動作:** `all` → `figma.variables.getLocalVariablesAsync()`(全ローカル変数)+ コレクション。`target` → ノード部分木を走査して `boundVariables` の id を集め、`getVariableByIdAsync` で解決。各変数: `{ id, name, key, resolvedType, collectionId, valuesByMode, description }`。コレクション: `{ id, name, modes, defaultModeId }`。
- **返り値:** `{ scope, count, variables, collections }`。

### `yfigma_search_design_system` — op `search_design_system`
- **入力:** `query`(部分一致), `kinds?`(`["component","style"]`), `allPages?`(既定 false), `limit?`(1–200、既定 50)。
- **動作:** コンポーネントは `root.findAllWithCriteria({types:["COMPONENT","COMPONENT_SET"]})` を名前で絞り込み。スタイルは `getLocalPaintStylesAsync` / `getLocalTextStylesAsync` / `getLocalEffectStylesAsync` を名前で絞り込み。各ヒット: `{ kind, type|styleType, id, name, key }`。
- **返り値:** `{ query, count, results }`。
- **注記:** 開いているファイルの**ローカル**コンポーネント/スタイルのみ。公開ライブラリのリモートコンポーネントは対象外。

### `yfigma_get_libraries` — op `libraries`
- **入力:** なし。
- **動作:** `figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()` → `{ key, name, libraryName }`。
- **返り値:** `{ note, libraryVariableCollections }`。
- **注記:** manifest `permissions: ["teamlibrary"]` が必要。プラグイン API はチームライブラリの**変数**コレクションのみ公開(コンポーネントライブラリの完全列挙は不可)。

### `yfigma_get_figjam` — op `figjam`
- **入力:** `url?`, `nodeId?`。
- **動作:** ターゲットノード → それ、なければ現在の選択、なければ現在ページ全体。`figjamNode`: `STICKY` / `SHAPE_WITH_TEXT` / `TEXT` には `{ id, name, type, text }`、加えて座標、`CONNECTOR` には `connectorStart`/`connectorEnd`、`children` を再帰。
- **返り値:** `{ page, count, nodes }`。

### `yfigma_get_document_info` — op `document_info`
- **入力:** なし。
- **動作:** `figma.root` / `figma.currentPage` を読む。
- **返り値:** `{ fileName, editorType, currentPage:{id,name}, pages:[{id,name,childCount}], selection:[{id,name,type}] }`。

### `yfigma_whoami` — op `whoami`
- **入力:** なし。
- **動作:** `figma.currentUser` を読む。
- **返り値:** `{ user:{id,name,photoUrl,color}, editorType, fileName, currentPage }`。
- **注記:** manifest `permissions: ["currentuser"]` が必要。

## エラー処理とタイムアウト

- プラグインハンドラが throw → `{ok:false, error}` → MCP は `isError` テキストを返す(例「Nothing is selected…」「Node not found…」)。
- **plugin 未接続** → bridge が即時に失敗を返す(待たない)。
- **タイムアウト** → `REQUEST_TIMEOUT_MS`(既定 30,000ms)以内に応答がなければ MCP はタイムアウトエラーで reject。
- `BridgeClient` は bridge へ自動再接続。プラグイン UI もソケット切断時に 2 秒ごとに自動再接続。

## 内蔵 bridge と独立 bridge

- **独立**(`npm run bridge`): bridge は独立プロセス。MCP の再起動を跨いで生存。clone 方式で使用。
- **内蔵**(`BRIDGE_EMBED=1`): `mcp.ts` がプロセス内で `startBridgeServer()` を呼ぶため、Copilot が MCP を起動すれば bridge も立つ — 別手順が不要。npx の多プロジェクト方式で使用。MCP 自身のクライアントは内蔵 bridge に localhost で接続し、プラグインはトンネル経由で全く同じように到達します。
