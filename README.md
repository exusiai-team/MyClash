# MyClash 订阅合并

把多个机场订阅合并成**一个**订阅链接（节点并集），再在客户端套用
[AIsouler/MyClash](https://github.com/AIsouler/MyClash) 的覆写脚本。

- **一键合并**：打开 Worker 地址就是管理页，粘贴多个机场订阅，按一下就生成合并后的订阅链接
- **即时节点**：客户端每次更新时，Worker 都会即时抓各机场的最新节点，并把流量加总显示
- **不怕屏蔽**：机场屏蔽 Cloudflare（`HTTP 403`）时，自动改用 GitHub Actions 代抓的缓存
- **多种格式**：支持 mihomo / Clash YAML 订阅，以及 base64 的 `ss` / `vmess` / `vless` / `trojan` / `hysteria2` 链接
- **免维护**：依赖每月自动更新、测试通过后自动合并，push 后 Cloudflare 自动重新部署

## 运作方式

```text
             每次更新订阅                      直连抓取
Clash 客户端 ───────────▶ Cloudflare Worker ───────────▶ 各机场订阅
                               │    ▲
                直连失败时读取 │    │ 每天 / 管理页「立即刷新缓存」写入
                               ▼    │
                             KV 缓存 ◀──── GitHub Actions（非 Cloudflare IP 代抓）
```

## 部署

### 第 1 步：部署 Worker

[![前往 Cloudflare 导入此仓库](https://img.shields.io/badge/Cloudflare-导入此仓库部署_Worker-F38020?logo=cloudflare&logoColor=white)](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create)

1. 点上面的按钮，登录（或免费注册）Cloudflare，选 **导入存储库（Import a repository）**
2. 选本仓库 **`MyClash`**（清单里没有的话，依提示安装 Cloudflare 的 GitHub App 并勾选本仓库）
3. 按下表设置，其他保持默认，然后按 **部署**：

   | 字段 | 填写 |
   | --- | --- |
   | 项目名称 | `myclash`（必须和 `wrangler.jsonc` 的 `name` 一致） |
   | 生产分支 | `main` |
   | 构建命令 | 留空 |
   | 部署命令 | `npx wrangler deploy` |
   | 根目录 | `/` |

4. 打开 Worker 地址（形如 `https://myclash.你的账号.workers.dev`），**这就是管理页**

> 存订阅用的 KV（`myclash-sub-store`）会在部署时自动创建，不用另外设置。

### 第 2 步：生成合并订阅

1. 打开管理页（不用密码），按「生成新的订阅」
2. 填名称，粘贴各机场的订阅链接（可用「批量粘贴」，一行一个）
3. 按「保存并生成链接」，再按「复制链接」或「一键导入 Clash」

### 第 3 步：代抓缓存（机场屏蔽 Cloudflare 时需要）

有些机场会屏蔽 Cloudflare Workers，Worker 抓它们时会得到 `HTTP 403`。GitHub Actions 每天会从 GitHub 的机器
把所有机场订阅抓一次存进 KV，Worker 直连失败时就改用这份缓存（保留 3 天）。

1. 到 Cloudflare 的 [API 令牌](https://dash.cloudflare.com/profile/api-tokens) → **创建令牌** → **创建自定义令牌**
   - 权限：`账户` / `Workers KV 存储` / `编辑`
   - 账户资源：包括你的账户
2. 到本仓库 **Settings → Secrets and variables → Actions → New repository secret**，
   名称填 `CLOUDFLARE_API_TOKEN`，值贴上令牌
3. 到 **Actions → 代抓订阅缓存 → Run workflow** 手动执行一次

> 账号与 KV 会自动寻找。若执行失败并提示「请在 Secrets 里直接指定」，再加上
> `CLOUDFLARE_ACCOUNT_ID`（Cloudflare 首页右侧的账户 ID）与 `KV_NAMESPACE_ID`（存储和数据库 → KV 里 `myclash-sub-store` 的 ID）。
> 日志只会印出数量，不会印出订阅链接或节点内容。

### 第 4 步：管理页「立即刷新缓存」（选做）

想在机场换节点后马上更新缓存、不等每天的定时任务，可以让管理页直接触发 GitHub Actions：

1. 到 GitHub 的 [Fine-grained tokens](https://github.com/settings/personal-access-tokens/new) 创建令牌
   - Repository access：**Only select repositories** → 选本仓库
   - Permissions → Repository permissions → **Actions**：`Read and write`
2. 到 Cloudflare 的 **Workers 和 Pages → myclash → 设置 → 变量和机密 → 添加**，
   类型选 **密钥**，名称填 `GITHUB_TOKEN`，值贴上令牌
3. 在管理页按某个订阅的「编辑」，就会看到「**立即刷新缓存**」按钮；按下后约 1 分钟完成（1 分钟内只能按一次）

> 仓库名称写在 `wrangler.jsonc` 的 `vars.GITHUB_REPO`，fork 后请改成自己的 `用户名/MyClash`。

## 客户端设置

1. 在 Clash Verge Rev / Mihomo Party / FlClash / Bettbox 等 mihomo 客户端，把合并订阅链接加成**远程订阅**，并打开自动更新
2. 对这个订阅添加**脚本覆写**：
   ```text
   https://raw.githubusercontent.com/AIsouler/MyClash/main/Script/Script.js
   ```
3. **关闭客户端的 DNS 覆写**（MyClash 脚本要求）

合并后的配置**不含** `proxy-providers`（MyClash 脚本遇到它会报错），并保留各机场的 `dns` / `hosts`，
让脚本能处理机场的私有 DNS。

## 管理页功能

| 功能 | 说明 |
| --- | --- |
| 复制链接 / 一键导入 Clash | 取得合并后的订阅链接 |
| 预览 | 即时抓取并显示合并结果；每个机场标出「直连」「缓存」或「失败」，以及流量与到期日 |
| 编辑 | 修改名称、节点前缀、机场清单；可按「立即刷新缓存」 |
| 换 TOKEN | 生成新链接，旧链接立即失效 |
| 删除 | 删除这个合并订阅 |
| 导入 TOKEN | 换设备或清除浏览器数据后，粘贴订阅链接找回清单 |

**节点前缀**：用来区分不同机场的节点。

- **机场名称**（默认）：自动读取机场名称（订阅返回的文件名，读不到就用订阅域名），例如 `飞云 | 香港 01`
- **S1、S2…**：按顺序编号，例如 `S1 | 香港 01`
- **不加前缀**：保留原本的节点名称，同名节点会自动加上 `2`、`3` 区分

也可以给单个机场填自定义前缀（「不加前缀」时不生效）。自定义前缀请避免「香港、日本、美国、HK、US、JP、机场、订阅」等字样，
否则会影响 MyClash 脚本的地区分组和节点过滤。

## 注意事项

- **TOKEN 等同密码**：拿到订阅链接的人就能用你的节点，也能编辑或删除这个订阅。外流时按「换 TOKEN」。
- **没有管理密码**：Worker 不提供「列出所有订阅」的功能，别人打开管理页只看得到自己生成的订阅。管理页的清单只记在你的浏览器里。
- **抓取失败**：直连失败且没有缓存的机场会被跳过，并在配置文件开头的注释标明原因。全部失败时 Worker 返回错误，
  客户端会保留上一次成功的配置。建议优先使用机场提供的 Clash / Meta 订阅链接。
- **免费额度**：Cloudflare Workers 免费方案每天 10 万次请求、KV 每天 1000 次写入；GitHub Actions 每次代抓不到 1 分钟，个人使用绰绰有余。

## 自动化

| 项目 | 时间 | 内容 |
| --- | --- | --- |
| 代抓订阅缓存 | 每天台湾时间 03:17，或管理页手动触发 | `.github/workflows/refresh-cache.yml` |
| 测试 | 每次 push / PR | 单元测试 + `wrangler deploy --dry-run`，使用最新的 Node 版本 |
| 依赖更新 | 每月 1 号 | Dependabot 把 npm 与 GitHub Actions 的更新合成**一个** PR，测试通过后自动合并到 `main` |
| 部署 | 每次 `main` 有更新 | Cloudflare 自动重新部署 Worker 与管理页 |

## 开发

```bash
npm install
npm test             # 单元测试
npx wrangler dev     # 本机运行 Worker（含本机 KV）
```

| 路径 | 说明 |
| --- | --- |
| `GET /sub/<TOKEN>` | 合并后的订阅（mihomo YAML） |
| `POST /api/subs` | 添加，内容 `{ "name": "...", "prefixMode": "name" \| "index" \| "none", "sources": [{ "name": "", "url": "https://..." }] }` |
| `GET` / `PUT` / `DELETE /api/subs/<TOKEN>` | 查找、编辑、删除（持有 TOKEN 即可） |
| `POST /api/subs/<TOKEN>/rotate` | 换新 TOKEN |
| `POST /api/subs/<TOKEN>/refresh` | 触发 GitHub Actions 代抓缓存（需设置 `GITHUB_TOKEN`，1 分钟内限一次） |

| 文件 | 说明 |
| --- | --- |
| `src/worker.js` | Worker：订阅输出与管理 API |
| `src/parse.js` | 订阅解析、合并、YAML 输出 |
| `src/cache.js` | 代抓缓存的 KV 键名与保留时间 |
| `scripts/refresh-cache.mjs` | GitHub Actions 代抓脚本 |
| `public/index.html` | 管理页 |

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)，例如 `feat: …`、`fix: …`、`docs: …`。

## 致谢

- [AIsouler/MyClash](https://github.com/AIsouler/MyClash)：覆写脚本
- [Kwisma/cf-SubCloud](https://github.com/Kwisma/cf-SubCloud)：架构参考
