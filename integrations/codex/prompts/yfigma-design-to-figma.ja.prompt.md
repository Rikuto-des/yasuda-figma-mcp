---
mode: agent
description: yasuda-figma-mcp の yfigma ツールで UI を設計し、開いている Figma ファイルへ出力する。
---

`yasuda-figma-mcp` の `yfigma_*` MCP ツールを使って、私が依頼する UI を設計し、開いている Figma ファイルへ書き込んでください。

目的:
- 依頼内容に合う、実用的で完成度の高い UI を設計する。
- 開いている Figma ファイル内の既存ローカルコンポーネント、バリアント、スタイル、変数から組み立てる。
- `yfigma_apply_ui_spec` で Figma に出力する。

ルール:
- Figma は Design mode で使う。Dev Mode やプラグイン未接続なら、私が直すべきことを具体的に伝える。
- `componentId`、変数 ID、prop key、variant value を推測で作らない。
- プラグインへ実行コードを送らない。宣言的な UI spec JSON だけを送る。
- プロダクト UI では、生の矩形や絶対座標を使わない。auto-layout frame と既存 component instance で構成する。
- gap、padding、fill はできるだけ `yfigma_get_variable_defs` の token reference を使う。
- 書き込み操作は `yfigma_apply_ui_spec` だけを使う。
- モバイル UI は、ヘッダー、主指標、補助指標、明確な次アクション、詳細セクション、必要な場合の bottom navigation まで含めた実際に使える画面にする。
- 1文字だけの avatar、意味のない色面、ラベルのない進捗ブロック、仮置きに見える四角形は避ける。
- 適用前に、視覚階層、余白のリズム、タップ可能性、選択状態、文字の収まり、色の意味づけを自己レビューする。

ループ:
1. 観測: `yfigma_get_document_info`、`yfigma_list_component_sets`、`yfigma_get_variable_defs` を呼ぶ。component 結果が truncated なら query を絞る。
2. 設計: 実在する component と variable を選び、`version: 1` かつ root が 1 つの UI spec を作る。
3. 自己レビュー: UI が操作可能なアプリ画面として成立しているか、仮置き感がないかを確認して spec を直す。
4. 検証: `validateOnly: true` で `yfigma_apply_ui_spec` を呼ぶ。
5. 修正: validation error をすべて直し、避けられる literal spacing/color warning は variable に置き換える。
6. 適用: `validateOnly` を外して `yfigma_apply_ui_spec` を呼ぶ。
7. 確認: 返された root id に対して `yfigma_get_screenshot` を呼び、表示が不完全または意図と違う場合は修正して再適用する。

target mode:
- 特に指定がなければ `target.mode: "create"` を使う。
- `"into-selection"` は、私が追加先の auto-layout parent frame を選択している場合だけ使う。
- `"update-selection"` は、私が更新対象 node を選択していて、root type が一致する場合だけ使う。

完了時は、作成/更新した Figma の root name/id、作った UI の概要、残った warning を報告してください。
