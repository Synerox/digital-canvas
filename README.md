# Digital Canvas

在瀏覽器執行的數位電路編輯與視覺化工具。可以從符號庫自己畫電路，也可以匯入 Verilog 自動產生頂層 Block Diagram 和各子模組的電路圖，再接著手動編輯。整個系統只在前端執行，設計原始碼不會上傳到任何伺服器。

完整規劃見專案文件「Digital Canvas 完整開發規劃」。

## 目前進度（階段 0–1）

- Yosys WASM（`@yowasp/yosys`）在 Web Worker 中執行，只做 elaboration：`read_verilog -sv` → `hierarchy` → `proc -noopt` → `opt_clean` → `write_json`。
- Netlist IR：位元層級連線重組為匯流排、切片與常數，每個 cell 有穩定 ID。
- 頂層 Block Diagram：訊號左進右出、bus 寬度斜線、分岔實心點、I/O pin、多段拼接的匯流排條。
- 雙擊 block 進入子模組，breadcrumb 和階層樹切換各層。
- 原始碼對應：點符號反白 Verilog 行，點程式碼行反白對應符號。
- 匯出 SVG / PNG，報告（白底）與簡報（米色底）兩種主題。

## 編輯器（階段 4）

- **自己畫**：左側符號庫有 I/O pin、常數、註解、AND/OR/XOR/NAND/NOR/XNOR/NOT/Buffer（2–32 輸入）、加減乘、比較器、MUX（2–32 輸入）、Decoder、移位器、暫存器（含 EN、非同步 reset）、匯流排合併/拆分，以及「模組方塊」（實例化 Verilog 模組或另一張手繪圖）。點一下符號再點畫布放置（Shift 連續放），或直接拖到畫布。
- **接線（直接畫）**：從 pin 拖曳，線跟著游標走，游標轉彎的地方就是轉角（斜著拖只會有一個轉角），放在 pin 或既有導線上完成；或點 pin 之後在空白處點出轉折、最後點 pin 或導線完成（Backspace 退回上一次點擊）。接到導線就是接到那條線的 net，會畫出分岔點；Alt+拖曳導線從那條線拉出分支。畫的線照原樣保留，只有沒畫的部分（例如放開時離 pin 還有一段）才自動以直角補上；目標 pin 朝另一邊時會繞過它的符號。沒有轉角、直接拖到 pin 的線如果會穿過其他符號，就改用自動走線繞過去。
- **調整導線**：拖曳任何一段線把它平移，相鄰兩段跟著伸縮；拖曳轉角同時移動兩段；接在 pin 上的第一段和最後一段也能拖，pin 端會留一小段短線接回 pin。同一個 net 共用的線段一起移動。選取的導線會顯示轉角控制點。
- **對齊格點**：所有符號和導線都在 10 px 格點上，相連的 pin 會對齊成直線，不會有 1–9 px 的小斷層或小折角（ELK 排版的結果也會先對齊格點）。舊存檔開啟時自動對齊。
- **編輯**：點選、Shift/Ctrl 加選、拖曳框選；拖曳移動（對齊格點）；Delete 刪除；Ctrl+C/X/V/D；Ctrl+Z / Ctrl+Shift+Z 復原重做；右側「Properties」改名稱、位元寬度、輸入數、常數值、導線標籤與取用位元，也可以直接改 JSON（例如 `{ "sym": "and", "inputs": 5, "width": 1 }`）。
- **Ctrl+Z 回上一層**：切換到別張圖也是一個復原步驟。雙擊 block 進入子模組後按 Ctrl+Z 回到主模組（畫面停在離開時的位置），Ctrl+Shift+Z 再進去；breadcrumb、階層樹、手繪圖清單和（在 Verilog 圖上）Block diagram / Full circuit 切換都一樣。在子模組裡改過東西時，Ctrl+Z 先復原那些修改，再回上一層。切換圖不會清掉重做紀錄。
- **JSON 元件**：符號庫最上面的「Components › Add…/Edit…」用 JSON 定義自己的元件，跟作品一起存檔。兩種：
  - 預設組合（preset）：內建符號加上設定，例如 `{ "name": "and5", "base": "and", "inputs": 5 }`、`{ "name": "mux4x8", "base": "mux", "inputs": 4, "width": 8 }`。可設定的欄位就是 Properties 裡的 `inputs`、`width`、`parts`、`shift`、`value`。
  - 自訂零件（part）：只有腳位、沒有內部邏輯，例如 `{ "name": "alu", "title": "ALU", "inputs": ["a[7:0]", "b[7:0]", "op[2:0]"], "outputs": ["y[7:0]", "zero"] }`；腳位也可以只給數量 `"inputs": 6`（名稱 in0、in1…，寬度用 `width`）。放置後是一個模組方塊，匯出 Verilog 時寫成空的 `(* blackbox *)` 模組。之後若匯入或畫了同名的模組，方塊就改用那個模組。
  - Properties 的「Save as a component」把選取符號目前的設定加進元件庫。
- **匯入 Verilog**：File › Import Verilog…（Ctrl+I）貼上或開檔，流程和 FSM Designer 相同。匯入後的圖可以直接編輯：移動、改名、刪除、加畫符號和導線。Verilog 決定電路結構，編輯另外以穩定 ID 存放，重新匯入修改過的 Verilog 時會保留手動位置、改名、刪除和手畫的部分；新出現的符號放在 ELK 建議的相對位置且不重疊。
- **Auto layout**（L）隨時用 ELK 重新排版整張圖（可復原）。「Copy to new drawing」把匯入的圖複製成完全獨立的手繪圖。
- **存檔**：Ctrl+S 下載 `.dcanvas.json`（含 Verilog 原始碼、手繪圖和所有編輯），Ctrl+O 開啟；另外會自動保留一份在瀏覽器中，重新整理不會遺失。
- **匯出**：SVG / PNG（報告白底、簡報米色底）；File › Export Verilog… 把目前這張圖轉成結構化 Verilog，並可用 Yosys 檢查。
- 介面操作參考 Analog Canvas（AGPL-3.0）的使用說明文件，程式碼完全自行撰寫，沒有使用其原始碼。

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
| `src/editor` | 編輯器核心：符號庫、文件格式（netlist 與 layout 分開）、編輯操作、走線器、幾何、Verilog 匯出 |
| `src/yosys` | Yosys 指令、Web Worker 與載入器 |
| `src/layout` | ELK.js 排版 |
| `src/render` | 教科書風格 SVG 繪製、主題、匯出 |
| `src/app` | React 介面：畫布、階層樹、程式碼面板 |
| `src/examples` | 內建範例設計 |

## 授權

MIT（暫定）。介面參考 Analog Canvas（AGPL-3.0）的設計，但不使用其程式碼。
