# IDE から Figma へ UI を書き込む（code → design）— 設計

> **ステータス：実装中（A〜C 実装済み・実機未検証）。** 本ドキュメントは設計の背景、確定
> スキーマと検証ルールは [UI_SPEC.ja.md](UI_SPEC.ja.md) を参照。書き込み op `apply_ui_spec`
> と観測 op `list_component_sets` を実装済み（frame / instance＋props / text / トークン
> バインド / HUG・FIXED・FILL）。**動作中の Figma での e2e 検証は未実施。** 前提として、
> read-only プロジェクトの中核思想 **「デザインデータを私設・ローカル経路の外へ一切出さ
> ない」**（S3なし・Figma RESTなし・第三者なし・公開ポートなし・外向きHTTPなし）を壊さ
> ないことを絶対条件とする（書き込みもローカル文書を変更するだけで、egress を増やさない）。

現状このサーバは read-only で、9つのツール（`src/mcp.ts` / `plugin/code.js`）は開いている
Figmaドキュメントを **読むだけ**。本設計では、IDE側エージェント（GitHub Copilot /
Claude Code）が **開いているファイル内の既存デザインシステム** から画面を組み立てられる
よう、**厳しく制約した少数の書き込み op** を足す。駆動は自然言語、コンテキストはIDEの
コードベース。

## ゴール

開発者がIDEで *「うちの Button と Input を使ってログイン画面を作って」* と言うだけで、
開いているファイルに **綺麗な** Figma 画面が生成される。ここで「綺麗」とは：

- **既存コンポーネント / バリアント** から構成（生の矩形を描かない）
- **オートレイアウト** で配置（絶対座標を使わない）
- 色・余白・タイポは **デザイントークン（変数）** にバインド
- そして **デザインデータを外部に一切送信しない**

## 採用しない方式：`use_figma`

公式 Figma MCP の `use_figma` は任意のJSを実行してデザインを作る。任意JSは **任意の
エンドポイント** へ `fetch` できるため、「データを外に出さない」思想と根本的に相容れない。
**よって採用しない。**

安全な代替＝本設計の核心は、プラグインが **モデルの書いたコードを一切実行しない** こと。
モデルが出すのは **宣言的JSON（コードではなくデータ）**、プラグインはそれを **固定の
op allowlist** で適用するだけ。

## セキュリティ不変条件（全書き込み op が満たす）

| 不変条件 | 意味 |
|---|---|
| **任意コード実行なし** | プラグインは allowlist した op の固定 `switch` のみ実行。モデル由来のJSを `eval`・解釈しない。 |
| **ネットワーク面を増やさない** | `manifest.json` の `networkAccess.allowedDomains` は `ws://localhost:3055` のみ据え置き。新ドメイン・送信系opを足さない。プラグインはローカル bridge **のみ** と通信。 |
| **送信系 op を作らない** | op 語彙は **ドキュメント変更のみ**。`fetch`相当・URL付与・解析送信は入れない。データを外に出す経路が物理的に無い。 |
| **入力は値として検証** | 数値はクランプ、バリアント値は実在enumのみ、コンポーネントはファイル内に実在する id/key で解決。文字列はデータとして扱う。 |
| **信頼境界は read-only と同一** | 賢さ（LLM）はユーザ自身のIDEエージェント（今日すでに読み取り文脈を託している相手）。プラグインはローカル専用クライアントのまま。 |

## アーキテクチャ

既存トランスポート（MCP ⇄ bridge ⇄ plugin を私設 `ws://127.0.0.1:3055` トンネル経由で接続。
[ARCHITECTURE.ja.md](ARCHITECTURE.ja.md) 参照）をそのまま再利用。足すのは **op だけ**で、
新プロセスも新ネットワーク経路も追加しない。

```
[IDEエージェント = 賢さ]        既存の信頼境界の中に留まる
   │  ① 観測: 既存 READ op で DS と選択を取得
   │  ② 計画: UI spec(JSON) を生成  ← コードではなくデータ
   ▼
[MCP server] ─stdio─► [bridge :3055] ─私設localhostトンネル─► [plugin]
                                                                 │
                                    ③ 適用: 固定op switchで確定的に構築
                                       create_frame / create_instance / set_properties …
   ◄──────────────────── ④ 確認: get_screenshot で撮り返し ───────┘
```

- **IDEエージェント** が賢さを担う：自然言語の解釈、コードベース文脈の読み取り、計画。
- **プラグイン** は確定的な実行器：宣言的 spec を allowlist op だけで適用。

### エディタモードの注意

- 書き込み op は **Design モード** 必須。Figma の **Dev Mode はプラグインが read-only**
  なので、Design モードでない時は明確にエラーを返す。
- `manifest.json` は `documentAccess: "dynamic-page"`。ノードアクセスは **非同期** API
  （`getNodeByIdAsync` / `getMainComponentAsync`）必須、テキストは作成/編集前に
  `figma.loadFontAsync` が必要。

## エージェントループ

1. **観測** — 既存 READ op でデザインシステムと現在の選択を取得。
2. **計画** — IDEエージェントが自然言語指示を **UI spec(JSON)** に変換。
3. **検証（書き込み前）** — spec を実DSと照合。存在しないコンポーネント・無効なバリアント
   値・未定義トークンは却下し、エージェントに差し戻す。
4. **適用** — プラグインが spec を書き込み op で確定的に実行。
5. **確認** — `get_screenshot` で結果を撮り、意図と差分を比較。必要なら再適用。

## op セット

### 読み（既存 — 「観測」「確認」に再利用）

- `search_design_system` / より詳細な `list_component_sets`（バリアント＋プロパティ値）
- `get_variable_defs`（トークン）
- `get_screenshot`（クローズドループ検証）

### 書き（新規 — allowlist、ドキュメント変更のみ）

| Op | 目的 | 主な Figma API |
|---|---|---|
| `create_frame` | オートレイアウトの画面コンテナ | `figma.createFrame()`, `layoutMode`, `itemSpacing`, `padding*` |
| `create_instance` | **既存** コンポーネント/バリアントをインスタンス化＋props設定 | id/key でノード解決 → `createInstance()`, `setProperties()` |
| `set_bound_variable` | 色・余白をトークン変数にバインド | `node.setBoundVariable()` |
| `set_text` | テキストノードに文字設定（先にフォント読込） | `figma.loadFontAsync()`, `characters` |
| `reorder` / `set_size`（任意） | 軽微な構造調整 | `appendChild`/`insertChild`, `resize` |

すべての書き込み op は：実在する部品/変数にのみ解決、パラメータをプラグイン側で再検証
（多層防御）、ネットワークI/O能力を持たない。

## 契約：UI spec(JSON)

IDE → プラグイン間を渡るのはこの宣言的JSONだけ。**コードではなくデータ** なので、流出も
実行もできない。

```jsonc
{
  "frame": {
    "name": "ログイン",
    "layout": "VERTICAL",        // オートレイアウト方向
    "gap": "{spacing.lg}",        // 直値ではなくトークン参照
    "padding": "{spacing.xl}"
  },
  "children": [
    { "use": "Input",  "byKey": "abc123", "props": { "Label": "メール" } },
    { "use": "Button", "byKey": "def456", "props": { "Variant": "Primary", "Label": "ログイン" } }
  ]
}
```

ルール：
- `use` / `byKey` は観測時に **実在確認済み** の部品のみ参照。
- `props` の値は **実在バリアント値** のみ（プラグイン側で再検証）。
- 余白・色は **トークン参照**（`{spacing.lg}`）で書き、直値の乱立を防ぎテーマ追従を維持。
- いかなるフィールドもコードとして解釈しない。

## 検証ルール（適用前）

- すべての `use`/`byKey` が実在の `COMPONENT` / `COMPONENT_SET` に解決される。
- すべての `props` のキー/値が `componentPropertyDefinitions` / `variantGroupProperties`
  に一致する。
- すべての `{token}` が `get_variable_defs` の実在変数に解決される。
- 数値propは妥当な範囲内、未知フィールドは却下。
- 失敗時は書き込まず、エラーをエージェントに返して spec を修復させる。

## IDEコンテキストの活かし方

IDE側の優位は、エージェントが **実コードベース**（コンポーネント定義・props・型・意図）を
見られる点。**Code Connect**（`get_code_connect_map`）で「コードのButton ⇄ Figmaの
Button」を対応付ければ、IDEの文脈が spec のコンポーネント選択を直接駆動できる。

## 実装済み / 未解決事項

**実装済み（A〜C、実機未検証）：** UI spec スキーマ確定（[UI_SPEC.ja.md](UI_SPEC.ja.md)）、
Design モードガード、`list_component_sets`、`apply_ui_spec`（frame / instance＋props /
text / トークンバインド / HUG・FIXED・FILL、atomic 適用、`validateOnly`）。ネストは再帰
フレームで対応済み。

**未解決 / 今後（D 以降）：**
- 実機 e2e 検証（`setBoundVariable` / `setProperties`＋フォント / `setBoundVariableForPaint`
  の挙動確認）— **最優先**。
- `INSTANCE_SWAP` props（key/id 解決の確定が必要）。
- チームライブラリ部品：`importComponentByKeyAsync`（publish 済み前提）。ローカル限定から拡張。
- 冪等性 / その場更新 vs 常に新規作成（現状は常に新規）。
- レスポンシブ制約（現状はオートレイアウトのみ）。

---

**次の一歩：** 動作中の Figma で `apply_ui_spec` を `validateOnly` → 本適用で e2e 検証し、
API 挙動の差異を潰す。
