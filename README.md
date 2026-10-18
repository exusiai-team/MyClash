# MyClash 訂閱合併

把多個機場訂閱合併成**一個**訂閱網址（節點聯集），再在客戶端套用
[AIsouler/MyClash](https://github.com/AIsouler/MyClash) 的覆寫腳本。

- 在 GitHub Pages 管理頁貼上多個機場訂閱，**按一下就產生**合併後的訂閱網址
- 每產生一次就是一個獨立的 **TOKEN**，可以在管理頁**編輯、刪除、換 TOKEN**
- 客戶端每次更新時，都會即時抓所有機場的最新節點，並把各機場的流量加總顯示
- 支援 mihomo / Clash YAML 訂閱，以及 base64 的 `ss` / `vmess` / `vless` / `trojan` / `hysteria2` 連結

## 一鍵部署（只要做一次）

### 第 1 步：部署 Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/silverwolfxai/MyClash)

1. 點上面的按鈕，登入（或免費註冊）Cloudflare，並依提示連結你的 GitHub
2. 在 **ADMIN_PASSWORD** 欄位填一組你自己的管理密碼（登入管理頁時要用）
3. 按 **Deploy**，等一兩分鐘
4. 完成後記下 Worker 網址，長得像 `https://myclash-sub.你的帳號.workers.dev`

> 存訂閱用的 KV 資料庫會自動建立，不用另外設定。

### 第 2 步：開啟 GitHub Pages 管理頁

到本 repo 的 **Settings → Pages**，**Source** 選 **GitHub Actions**。
之後到 **Actions → 部署管理頁到 GitHub Pages → Run workflow** 執行一次（之後修改 `docs/` 會自動部署）。

管理頁網址：<https://silverwolfxai.github.io/MyClash/>

### 第 3 步：產生合併訂閱

1. 打開管理頁，填入第 1 步的 Worker 網址和管理密碼，按「登入」
2. 按「產生新的訂閱」，填名稱並貼上各機場的訂閱網址（可用「批次貼上」，一行一個）
3. 按「儲存並產生連結」，再按「複製連結」或「一鍵匯入 Clash」

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

- **TOKEN 等同密碼**：拿到訂閱網址的人就能用你的節點。外流時在管理頁按「換 TOKEN」，舊網址會立即失效。
- **節點前綴**：每個機場的節點都會加上前綴（例如 `S1 | 香港 01`）避免重名。自訂前綴時，請避免
  「香港、日本、美国、HK、US、JP、机场、订阅」等字樣，否則會影響 MyClash 腳本的地區分組和節點過濾。
- **抓取失敗**：少數機場會封鎖 Cloudflare 的 IP，或回傳不支援的格式。失敗的機場會被跳過，並在設定檔開頭用註解標示；
  全部失敗時 Worker 會回傳錯誤，客戶端會保留上一次成功的設定。建議優先使用機場提供的 Clash / Meta 訂閱連結。
- **免費額度**：Cloudflare Workers 免費方案每天 10 萬次請求、KV 每天 1000 次寫入，個人使用綽綽有餘。
- **管理密碼**：要修改的話，到 Cloudflare 後台 → Workers → `myclash-sub` → 設定 → 變數和機密，修改 `ADMIN_PASSWORD`。
- **更新 Worker 程式**：一鍵部署會在你的 GitHub 另外建立一個 Worker 專用的 repo，並設定好自動部署。
  要更新 Worker，請修改那個 repo（push 後 Cloudflare 會自動重新部署）。

## 開發

```bash
npm install
npm test                                     # 單元測試
echo "ADMIN_PASSWORD=test" > .dev.vars
npx wrangler dev                             # 本機執行 Worker（含本機 KV）
```

| 路徑 | 說明 |
| --- | --- |
| `GET /sub/<TOKEN>` | 合併後的訂閱（mihomo YAML） |
| `GET /api/subs` | 列出所有訂閱組（需 `Authorization: Bearer <ADMIN_PASSWORD>`） |
| `POST /api/subs` | 新增，內容 `{ "name": "...", "sources": [{ "name": "", "url": "https://..." }] }` |
| `GET` / `PUT` / `DELETE /api/subs/<TOKEN>` | 查詢、編輯、刪除 |
| `POST /api/subs/<TOKEN>/rotate` | 換新 TOKEN |

## 致謝

- [AIsouler/MyClash](https://github.com/AIsouler/MyClash)：覆寫腳本
- [Kwisma/cf-SubCloud](https://github.com/Kwisma/cf-SubCloud)：架構參考
