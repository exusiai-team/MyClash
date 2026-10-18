# MyClash 訂閱合併

把多個機場訂閱合併成**一個**訂閱網址（節點聯集），再在客戶端套用
[AIsouler/MyClash](https://github.com/AIsouler/MyClash) 的覆寫腳本。

- 打開 Worker 網址就是管理頁，貼上多個機場訂閱，**按一下就產生**合併後的訂閱網址
- 每產生一次就是一個獨立的 **TOKEN**，可以在管理頁**編輯、刪除、換 TOKEN**
- 客戶端每次更新時，都會即時抓所有機場的最新節點，並把各機場的流量加總顯示
- 支援 mihomo / Clash YAML 訂閱，以及 base64 的 `ss` / `vmess` / `vless` / `trojan` / `hysteria2` 連結

## 部署（只要做一次）

### 第 1 步：部署 Worker（直接連本倉庫，不會建立新倉庫）

[![前往 Cloudflare 匯入此倉庫](https://img.shields.io/badge/Cloudflare-匯入此倉庫部署_Worker-F38020?logo=cloudflare&logoColor=white)](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create)

1. 點上面的按鈕，登入（或免費註冊）Cloudflare，選 **匯入存放庫（Import a repository）**
2. 選 GitHub 帳號 `silverwolfxai` 和 **`MyClash`** 倉庫
   （清單裡沒有的話，依提示安裝 Cloudflare 的 GitHub App，並勾選 `MyClash`）
3. 設定如下，其他維持預設，然後按 **部署**：

   | 欄位 | 填寫 |
   | --- | --- |
   | 專案名稱 | `myclash`（必須和 `wrangler.jsonc` 的 `name` 一致） |
   | 生產分支 | `main` |
   | 建置命令 | 留空 |
   | 部署命令 | `npx wrangler deploy` |
   | 根目錄 | `/` |

4. 打開 Worker 網址（長得像 `https://myclash.你的帳號.workers.dev`），**這就是管理頁**

> 存訂閱用的 KV 資料庫會在部署時自動建立，不用另外設定。
> 之後 push 到本倉庫，Cloudflare 會自動重新部署 Worker 和管理頁。

### 第 2 步：產生合併訂閱

1. 打開 Worker 網址（不用密碼）
2. 按「產生新的訂閱」，填名稱並貼上各機場的訂閱網址（可用「批次貼上」，一行一個）
3. 按「儲存並產生連結」，再按「複製連結」或「一鍵匯入 Clash」

> 管理頁也同時部署在 GitHub Pages：<https://silverwolfxai.github.io/MyClash/>（需在 Settings → Pages 選 GitHub Actions），
> 在那邊使用時要另外填 Worker 網址；直接用 Worker 網址最方便。

## 客戶端設定

1. 在 Clash Verge Rev / Mihomo Party / FlClash / Bettbox 等 mihomo 客戶端，把合併訂閱網址加成**遠端訂閱**，並開啟自動更新
2. 對這個訂閱新增**腳本覆寫**：
   ```text
   https://raw.githubusercontent.com/AIsouler/MyClash/main/Script/Script.js
   ```
3. **關閉客戶端的 DNS 覆寫**（MyClash 腳本要求）

合併後的設定**不含** `proxy-providers`（MyClash 腳本遇到 `proxy-providers` 會報錯），
並保留各機場的 `dns` / `hosts`，讓腳本能處理機場的私有 DNS。

## 注意事項

- **TOKEN 等同密碼**：拿到訂閱網址的人就能用你的節點，也能編輯或刪除這個訂閱。外流時在管理頁按「換 TOKEN」，舊網址會立即失效。
- **不需要管理密碼**：Worker 沒有「列出所有訂閱」的功能，別人打開管理頁只會看到他自己產生的訂閱，看不到你的。
  管理頁的清單記在你的瀏覽器裡；換裝置或清除瀏覽器資料後，用「匯入 TOKEN」貼上訂閱網址就能找回來。
- **節點前綴**：每個機場的節點都會加上前綴（例如 `S1 | 香港 01`）避免重名。自訂前綴時，請避免
  「香港、日本、美国、HK、US、JP、机场、订阅」等字樣，否則會影響 MyClash 腳本的地區分組和節點過濾。
- **抓取失敗**：少數機場會封鎖 Cloudflare 的 IP，或回傳不支援的格式。失敗的機場會被跳過，並在設定檔開頭用註解標示；
  全部失敗時 Worker 會回傳錯誤，客戶端會保留上一次成功的設定。建議優先使用機場提供的 Clash / Meta 訂閱連結。
- **免費額度**：Cloudflare Workers 免費方案每天 10 萬次請求、KV 每天 1000 次寫入，個人使用綽綽有餘。
- **更新程式**：Worker 和管理頁都在本倉庫，push 後 Cloudflare 會自動重新部署。

## 開發

```bash
npm install
npm test                                     # 單元測試
npx wrangler dev                             # 本機執行 Worker（含本機 KV）
```

| 路徑 | 說明 |
| --- | --- |
| `GET /sub/<TOKEN>` | 合併後的訂閱（mihomo YAML） |
| `POST /api/subs` | 新增，內容 `{ "name": "...", "sources": [{ "name": "", "url": "https://..." }] }` |
| `GET` / `PUT` / `DELETE /api/subs/<TOKEN>` | 查詢、編輯、刪除（持有 TOKEN 即可） |
| `POST /api/subs/<TOKEN>/rotate` | 換新 TOKEN |

## 致謝

- [AIsouler/MyClash](https://github.com/AIsouler/MyClash)：覆寫腳本
- [Kwisma/cf-SubCloud](https://github.com/Kwisma/cf-SubCloud)：架構參考
