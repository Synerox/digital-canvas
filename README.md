# Digital Canvas

在瀏覽器執行的數位電路編輯與視覺化工具。可以從符號庫自己畫電路，也可以匯入 Verilog 自動產生頂層 Block Diagram 和各子模組的電路圖，再接著手動編輯。整個系統只在前端執行，設計原始碼不會上傳到任何伺服器。

完整規劃見專案文件「Digital Canvas 完整開發規劃」。

## 目前進度（階段 0–1）

- Yosys WASM（`@yowasp/yosys`）在 Web Worker 中執行，只做 elaboration：`read_verilog -sv` → `hierarchy` → `proc -noopt` → `opt_clean` → `write_json`。
- Netlist IR：位元層級連線重組為匯流排、切片與常數，每個 cell 有穩定 ID。
- 頂層 Block Diagram：訊號左進右出、bus 寬度斜線、分岔實心點、I/O pin、多段拼接的匯流排條。
- 雙擊 block 進入子模組，breadcrumb 和階層樹切換各層。
- 等價轉換一律套用（沒有開關）：`1 << x` 畫成 Decoder；跟常數 0 選擇的 MUX 畫成 AND 閘（S 為 0 時才通過的一邊在 S 輸入加反相圈）；算術運算元的高位補零 `{2'b00, x}` 畫成一般導線；低位補零 `{x, 2'b00}` 在導線上標 ×4。舊存檔裡關掉轉換的設定會被忽略。
- 只做畫圖：右側只有 Properties，沒有 Verilog 原始碼面板，符號和程式碼行也不互相反白（Verilog 只用來產生電路圖）。
- 匯出 SVG / PNG，畫面和匯出都是白底（米色底的簡報主題已移除，舊存檔照樣能開）。

## 編輯器（階段 4）

- **自己畫**：左側符號庫有 I/O pin、常數、註解、AND/OR/XOR/NAND/NOR/XNOR/NOT/Buffer（2–32 輸入）、加減乘、比較器、MUX（2–32 輸入）、Decoder、移位器、暫存器（含 EN、非同步 reset）、匯流排合併/拆分，以及「模組方塊」（實例化 Verilog 模組或另一張手繪圖）。點一下符號後，每點一下畫布就放一個，按 Esc（或再點一次該符號）停止；或直接拖到畫布放一個。
- **接線（直接畫）**：從 pin 拖曳，線跟著游標走，游標轉彎的地方就是轉角（斜著拖只會有一個轉角），放在 pin 或既有導線上完成；或點 pin 之後在空白處點出轉折、最後點 pin 或導線完成（Backspace 退回上一次點擊）。接到導線就是接到那條線的 net，會畫出分岔點；Alt+拖曳導線從那條線拉出分支。畫的線照原樣保留，只有沒畫的部分（例如放開時離 pin 還有一段）才自動以直角補上；目標 pin 朝另一邊時會繞過它的符號。沒有轉角、直接拖到 pin 的線如果會穿過其他符號，就改用自動走線繞過去。
- **調整導線**：拖曳任何一段線把它平移，相鄰兩段跟著伸縮；拖曳轉角同時移動兩段；接在 pin 上的第一段和最後一段也能拖，pin 端會留一小段短線接回 pin。同一個 net 共用的線段一起移動。選取的導線會顯示轉角控制點。
- **符號外形（教科書畫法）**：加減乘畫成 ALU 梯形（兩個運算元從缺口上下進來，輸出邊是輸入邊的一半長）；MUX 是往輸出變窄的梯形，輸入依序標 0、1、2…，選擇訊號 S 從下方斜邊的短引線接出；比較器是圓形；多輸入的閘本體最多四到五個輸入高，更多輸入時背線直線延伸到外側輸入，不會被拉成細長的子彈形（輸入變多時閘會變寬，右邊的符號和導線跟著往右移，不會被蓋住）；暫存器的 D、Q 寫在各自的腳位旁。舊存檔開啟時，變大的符號會自動讓出空間（包括刪掉後可以 Restore 回來的符號）。整體只有一種樣式：白底黑線。
- **連接點與位元寬度**：滑鼠指到符號時才用綠色小點顯示它的輸入輸出連接點（不再一直顯示，避免看起來像反相器的小圓圈），指到某個 pin 時那一點會放大。設定裡的 `width` 是位元數（不是符號的大小）：還沒接線的匯流排 pin 會畫一小段短線加上斜線和位元數（例如 `/8`），所以改了寬度馬上看得到；接上線之後改由導線上的斜線標示。這些提示只在編輯畫面顯示，不會出現在匯出的圖裡。沒接線的輸入不再畫記號；右側「n inputs not connected」那一行可以點，會選取有輸入沒接線的符號。
- **對齊格點**：所有符號和導線都在 10 px 格點上，相連的 pin 會對齊成直線，不會有 1–9 px 的小斷層或小折角（ELK 排版的結果也會先對齊格點）。舊存檔開啟時自動對齊。
- **編輯**：點選、Shift/Ctrl 加選、拖曳框選；拖曳移動（對齊格點）；Delete 刪除；Ctrl+C/X/V/D；Ctrl+Z / Ctrl+Shift+Z 復原重做；右側「Properties」只放必要的欄位：名稱、位元寬度、輸入數、常數值、I/O pin 的顯示方式、導線標籤與取用位元（腳位清單收在「n pins」裡）。上方工具列的「Hints」列出所有按鍵和滑鼠操作。
- **I/O pin 顯示成標籤或純文字**：選取 pin 後在 Properties 的「Show as」切換 Label（名稱外面有標籤框，預設）或 Text（只有名稱，寫在導線端點旁：input 的名稱靠右接在線的起點前、output 的名稱接在線的終點後、inout 置中）。手畫的 pin 和匯入 Verilog 的 pin 都可以切換；同時選多個符號時「Show n pins as」一次改全部，一次是一個復原步驟。只改外觀：pin 的大小、連接點和導線都不變。存檔、複製貼上、Copy to new drawing 和 SVG/PNG 匯出都照設定畫；pin 的 JSON 也有 `"style": "label"` 或 `"text"`，預設組合也能設定（例如 `{ "name": "in_txt", "base": "input", "style": "text" }`）。舊存檔的 pin 都是標籤。
- **雙擊**：有子模組的 block 進入子模組；有設定的符號（閘、MUX、加法器、暫存器、常數…）開一個小視窗用 JSON 編輯設定（每個項目一行，例如 `"inputs": 5`），Apply（Ctrl+Enter）套用、Esc 或 Cancel 取消，一次套用是一個復原步驟；在那個元件上繼續點不會關掉視窗，點其他地方會套用改好的內容再關（和 Properties 欄位離開時一樣；JSON 有錯時視窗留著並顯示錯誤），關掉後再點兩下一定會再打開；自訂零件（part）的方塊和符號庫 Components 裡的元件開同樣的小視窗編輯它的定義（改腳位會改到每個方塊）；I/O pin、註解和導線還是改名稱。Properties 的「JSON…」按鈕也能打開。
- **Ctrl+Z 回上一層**：切換到別張圖也是一個復原步驟。雙擊 block 進入子模組後按 Ctrl+Z 回到主模組（畫面停在離開時的位置），Ctrl+Shift+Z 再進去；breadcrumb、階層樹、手繪圖清單和（在 Verilog 圖上）Block diagram / Full circuit 切換都一樣。在子模組裡改過東西時，Ctrl+Z 先復原那些修改，再回上一層。切換圖不會清掉重做紀錄。
- **JSON 元件**：符號庫最上面的「Components › Add…/Edit…」用 JSON 定義自己的元件，跟作品一起存檔。兩種：
  - 預設組合（preset）：內建符號加上設定，例如 `{ "name": "and5", "base": "and", "inputs": 5 }`、`{ "name": "mux4x8", "base": "mux", "inputs": 4, "width": 8 }`。可設定的欄位就是 Properties 裡的 `inputs`、`width`、`parts`、`shift`、`value`，以及 I/O pin 的 `style`。改了預設組合（例如把 mux4x8 的 `width` 改成 16），從它放下的符號會一起改（同一個復原步驟）；單獨改過設定的符號就變成獨立的符號，不再跟著改；設定已經和預設組合不同的符號（例如從別的檔案貼上的）也不會被改。在 Components 視窗裡改名（同一個位置、同一種符號），放下的符號會跟著新名字。
  - 自訂零件（part）：只有腳位、沒有內部邏輯，例如 `{ "name": "alu", "title": "ALU", "inputs": ["a[7:0]", "b[7:0]", "op[2:0]"], "outputs": ["y[7:0]", "zero"] }`；腳位也可以只給數量 `"inputs": 6`（名稱 in0、in1…）。`width` 是沒寫位元的腳位（例如 `"a"`）的寬度；所有腳位一樣寬時，JSON 會寫成名稱加一個 `"width"`，改它就改到全部腳位。每個腳位都寫了自己的位元、`width` 卻跟每一個都不同時會提示錯誤，不會默默忽略。放置後是一個模組方塊（只有腳位的黑盒子）。之後若匯入或畫了同名的模組，方塊就改用那個模組。
  - 符號的 JSON 小視窗裡「Save as a component」把輸入的設定加進元件庫；在符號庫雙擊元件可以只改那一個。
- **匯入 Verilog**：File › Import Verilog…（Ctrl+I）貼上或開檔，流程和 FSM Designer 相同。匯入後的圖可以直接編輯：移動、改名、刪除、加畫符號和導線。Verilog 決定電路結構，編輯另外以穩定 ID 存放，重新匯入修改過的 Verilog 時會保留手動位置、改名、刪除和手畫的部分；新出現的符號放在 ELK 建議的相對位置且不重疊。
- **Auto layout**（L）隨時用 ELK 重新排版整張圖（可復原）。「Copy to new drawing」把匯入的圖複製成完全獨立的手繪圖。
- **存檔**：Ctrl+S 下載 `.dcanvas.json`（含 Verilog 原始碼、手繪圖和所有編輯），Ctrl+O 開啟；另外會自動保留一份在瀏覽器中，重新整理不會遺失。
- **匯出**：SVG / PNG（白底）。（「匯出 Verilog」功能已移除。）
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
| `src/editor` | 編輯器核心：符號庫、文件格式（netlist 與 layout 分開）、編輯操作、走線器、幾何 |
| `src/yosys` | Yosys 指令、Web Worker 與載入器 |
| `src/layout` | ELK.js 排版 |
| `src/render` | 教科書風格 SVG 繪製、配色、匯出 |
| `src/app` | React 介面：畫布、階層樹、Properties |
| `src/examples` | 內建範例設計 |

## 授權

MIT（暫定）。介面參考 Analog Canvas（AGPL-3.0）的設計，但不使用其程式碼。
