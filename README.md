# Digital Canvas

在瀏覽器執行的數位電路視覺化工具。匯入 Verilog 後自動產生頂層 Block Diagram，雙擊任一個 block 就能進入子模組的電路圖。整個系統只在前端執行，設計原始碼不會上傳到任何伺服器。

完整規劃見專案文件「Digital Canvas 完整開發規劃」。

## 目前進度（階段 0–1）

- Yosys WASM（`@yowasp/yosys`）在 Web Worker 中執行，只做 elaboration：`read_verilog -sv` → `hierarchy` → `proc -noopt` → `opt_clean` → `write_json`。
- Netlist IR：位元層級連線重組為匯流排、切片與常數，每個 cell 有穩定 ID。
- 頂層 Block Diagram：訊號左進右出、bus 寬度斜線、分岔實心點、I/O pin、多段拼接的匯流排條。
- 雙擊 block 進入子模組，breadcrumb 和階層樹切換各層。
- 原始碼對應：點符號反白 Verilog 行，點程式碼行反白對應符號。
- 匯出 SVG / PNG，報告（白底）與簡報（米色底）兩種主題。

## 開發

```bash
npm install
npm run dev      # 開發伺服器
npm test         # 單元測試（在 Node 中實際執行 Yosys）
npm run build    # 輸出到 dist/
```

`npm run dev` 和 `npm run build` 會先執行 `scripts/prepare-yosys.mjs`，把 Yosys 的 68 MB WASM 核心壓縮成約 16 MB 放到 `public/yosys/`，瀏覽器載入時再解壓。

## 程式結構

| 目錄 | 內容 |
| --- | --- |
| `src/core` | Yosys JSON 型別、Netlist IR、Diagram 模型（不依賴 DOM） |
| `src/yosys` | Yosys 指令、Web Worker 與載入器 |
| `src/layout` | ELK.js 排版 |
| `src/render` | 教科書風格 SVG 繪製、主題、匯出 |
| `src/app` | React 介面：畫布、階層樹、程式碼面板 |
| `src/examples` | 內建範例設計 |

## 授權

MIT（暫定）。介面參考 Analog Canvas（AGPL-3.0）的設計，但不使用其程式碼。
