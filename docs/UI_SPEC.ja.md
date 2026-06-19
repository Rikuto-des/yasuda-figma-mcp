# UI spec — IDE ⇄ プラグインの契約

> **ステータス：確定（v1）。** 実装は段階導入中。本ドキュメントは `apply_ui_spec`
> が受け取る **宣言的JSON** の確定スキーマと検証ルールを定義する。設計の背景は
> [IDE_TO_FIGMA.ja.md](IDE_TO_FIGMA.ja.md) を参照。

IDE エージェントは画面を **データ（この spec）** として計画する。**コードは渡さない。**
プラグインは固定の op 語彙で spec を確定的に適用するだけ。spec は流出も実行もできない。

構造ルールの **単一情報源** は [`src/ui-spec.ts`](../src/ui-spec.ts)。MCP サーバはこの
`validateUiSpec` で不正な spec を早期却下し、プラグインは同じルールを（素のJSで）再実装して
書き込み前にもう一度検証する（多層防御）。

## 確定した設計判断

| 判断 | 決定 |
|---|---|
| 適用方式 | **単一 `apply_ui_spec`**。1ルートを **atomic** に適用（途中失敗なら何も残さない） |
| 部品スコープ | **ローカル部品のみ**（`importComponentByKeyAsync` は MVP 非対象） |
| 冪等性 | **常に新規作成**（その場更新なし。spec は「これから作るもの」だけを記述） |
| props 指定 | **フレンドリ名**で書く。プラグインが `name#id` の厳密キーへ解決 |
| リテラル値 | 許可。ただし **色・余白のリテラルは警告**（トークン参照を推奨） |
| instance の子 | **不可**。ネストのカスタマイズは props（INSTANCE_SWAP 含む）経由 |

## エンベロープ

```jsonc
{
  "version": 1,
  "validateOnly": false,   // true なら書かずに検証レポートだけ返す
  "root": { /* 1個のノード（通常 frame） */ }
}
```

- ルートは **1ノード**。配置はビューポート中央に作成し、選択＋ズームする。座標は spec に
  持たせない（絶対座標を使わない方針）。

## ノード型

ツリーは `type` で判別する。**未知の `type` と未知フィールドは却下**（コード混入の防御）。

### `frame` — オートレイアウトの箱（子を持てる唯一の型）

| フィールド | 型 | 既定 / 備考 |
|---|---|---|
| `type` | `"frame"` | 必須 |
| `name` | string | 省略可 |
| `layout` | `"VERTICAL"` \| `"HORIZONTAL"` | 必須 |
| `gap` | 数値 \| トークン参照 | アイテム間隔。リテラルは警告 |
| `padding` | 数値 \| `{top,right,bottom,left}` \| トークン参照 | 各辺は数値 or トークン参照。リテラルは警告 |
| `primaryAxisAlign` | `MIN`\|`CENTER`\|`MAX`\|`SPACE_BETWEEN` | 省略可 |
| `counterAxisAlign` | `MIN`\|`CENTER`\|`MAX`\|`STRETCH` | 省略可 |
| `width` / `height` | `"HUG"` \| `"FILL"` \| 数値 | 既定 `HUG`。`FILL` は親内で伸びる子用 |
| `fill` | hex文字列 \| `"NONE"` \| トークン参照 | 省略可。`"NONE"` で塗りなし。リテラルは警告 |
| `children` | ノード配列 | 省略可 |

### `instance` — **既存**ローカル部品のインスタンス

| フィールド | 型 | 備考 |
|---|---|---|
| `type` | `"instance"` | 必須 |
| `componentId` | string | 必須。**COMPONENT または COMPONENT_SET** の node id |
| `name` | string | 省略可 |
| `props` | `{ [name]: string\|number\|boolean }` | バリアント・TEXT・BOOLEAN・INSTANCE_SWAP をフレンドリ名で |

- COMPONENT_SET を指したら、プラグインが `defaultVariant` をインスタンス化 → `setProperties`
  で VARIANT 切替＋他 props を適用。COMPONENT 単体なら直接 `createInstance()`。
- **子は持てない**（`children` 不可）。

### `text` — コンポーネントで賄えない素テキスト

| フィールド | 型 | 備考 |
|---|---|---|
| `type` | `"text"` | 必須 |
| `characters` | string | 必須 |
| `name` | string | 省略可 |
| `textStyleId` | string | 省略可（テキストスタイル推奨） |
| `fill` | hex文字列 \| `"NONE"` \| トークン参照 | 省略可。リテラルは警告 |
| `fontSize` | 数値 | `textStyleId` が無い時のフォールバック |

## 値の型：リテラル vs トークン参照

数値・色を取るフィールドは2形態を受け付ける。

- **リテラル**：`16` / `"#1A73E8"`（`#RRGGBB` または `#RRGGBBAA`）
- **塗りなし**：`fill` に `"NONE"` を指定するとフレーム既定の白塗りを除去できる
- **トークン参照**：

```jsonc
{ "var": "VariableID:1:5", "name": "spacing/lg" }
```

- 解決は **`var`（Figma 変数 id）のみ**。`name` はエラー表示用の任意ラベルで、解決には使わない。
- ドキュメントの `{spacing.lg}` 記法は **agent 側のシュガー**。`get_variable_defs` で得た id に
  計画時に変換し、ワイヤを通るのは常に id。
- ある値がトークン参照かどうかは「`var` キーを持つオブジェクトか」で判定する
  （per-side padding マップやリテラルと区別するため）。

## props のキー解決

Figma の property key は型で形式が違う：

- **VARIANT** → 素の名前（例 `"Size"`）
- **TEXT / BOOLEAN / INSTANCE_SWAP** → `name#id`（例 `"Label#7:0"`）

spec は **フレンドリ名で書く**。プラグインが `componentPropertyDefinitions` を使って正確キーへ
解決する。同名衝突がある時だけ厳密キーを要求し、エラーで差し戻す。

## 検証の二層

| 層 | 場所 | 内容 |
|---|---|---|
| **構造検証** | `src/ui-spec.ts`（MCP 早期却下＋プラグインで再実装） | `type` 既知 / enum 妥当 / 数値は有限かつ ≥0 / `{var}` の形 / hex 形式 / 未知フィールド却下 / ルートは1個 |
| **意味検証** | プラグインのみ（実ドキュメント照合） | `componentId` が**ローカル**の COMPONENT/COMPONENT_SET に解決 / props キー・値が定義と一致（VARIANT 値は `variantOptions` 内）/ `var` id が実在＋型一致（spacing=FLOAT, fill=COLOR）/ 数値クランプ / `editorType === "figma"` |

構造検証は **すべての問題を収集**してから返す（早期失敗しない）ので、agent は一度の往復で
spec 全体を修復できる。

## 適用結果（返り値）

```jsonc
// 適用時
{
  "ok": true,
  "root": { "id": "120:5", "name": "ログイン" },
  "created": ["120:5", "120:6", "120:7", "120:8"],
  "warnings": []
}

// validateOnly: true のとき（書き込みなし）
{
  "ok": true,
  "valid": false,
  "errors": [
    { "path": "root.children[2].props.Variant",
      "message": "'Primry' は variantOptions [Primary, Secondary] にない" }
  ],
  "warnings": [
    { "path": "root.gap", "message": "literal spacing — prefer a token reference" }
  ]
}
```

## 具体例（Input + Button のログイン画面）

```jsonc
{
  "version": 1,
  "root": {
    "type": "frame", "name": "ログイン", "layout": "VERTICAL",
    "gap": { "var": "VariableID:1:5", "name": "spacing/md" },
    "padding": { "var": "VariableID:1:9", "name": "spacing/xl" },
    "counterAxisAlign": "STRETCH", "width": 360,
    "children": [
      { "type": "text", "characters": "サインイン", "textStyleId": "S:heading" },
      { "type": "instance", "componentId": "12:34", "props": { "Label": "メール" } },
      { "type": "instance", "componentId": "12:34", "props": { "Label": "パスワード" } },
      { "type": "instance", "componentId": "56:78",
        "props": { "Variant": "Primary", "Label": "ログイン" } }
    ]
  }
}
```

## バージョニング

`version` は `1`。`apply_ui_spec` は一致しない `version` を却下する。破壊的変更は
`version` を上げ、プラグイン側で旧バージョンの受理可否を判断する。

---

**次の一歩（A-2 / A-3）：** プラグインに Design モードガードを足し、観測 op
`list_component_sets`（バリアント定義・正確な property key）を追加してから、`apply_ui_spec`
を縦に貫通実装する。
