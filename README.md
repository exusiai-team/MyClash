# MyClash 订阅合并

把多个机场订阅合并成**一个**订阅链接（节点并集），再在客户端套用
[AIsouler/MyClash](https://github.com/AIsouler/MyClash) 的覆写脚本。

- 打开 Worker 地址就是管理页，粘贴多个机场订阅，**按一下就生成**合并后的订阅链接
- 每生成一次就是一个独立的 **TOKEN**，可以在管理页**编辑、删除、换 TOKEN**
- 客户端每次更新时，都会即时抓所有机场的最新节点，并把各机场的流量加总显示
- 支持 mihomo / Clash YAML 订阅，以及 base64 的 `ss` / `vmess` / `vless` / `trojan` / `hysteria2` 链接

## 部署（只要做一次）

### 第 1 步：部署 Worker（直接连本仓库，不会创建新仓库）

[![前往 Cloudflare 导入此仓库](https://img.shields.io/badge/Cloudflare-导入此仓库部署_Worker-F38020?logo=cloudflare&logoColor=white)](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create)

1. 点上面的按钮，登录（或免费注册）Cloudflare，选 **导入存储库（Import a repository）**
2. 选 GitHub 账号 `silverwolfxai` 和 **`MyClash`** 仓库
   （清单里没有的话，依提示安装 Cloudflare 的 GitHub App，并勾选 `MyClash`）
3. 设置如下，其他保持默认，然后按 **部署**：

   | 字段 | 填写 |
   | --- | --- |
   | 项目名称 | `myclash`（必须和 `wrangler.jsonc` 的 `name` 一致） |
   | 生产分支 | `main` |
   | 构建命令 | 留空 |
   | 部署命令 | `npx wrangler deploy` |
   | 根目录 | `/` |

4. 打开 Worker 地址（长得像 `https://myclash.你的账号.workers.dev`），**这就是管理页**

> 存订阅用的 KV 数据库会在部署时自动创建，不用另外设置。
> 之后 push 到本仓库，Cloudflare 会自动重新部署 Worker 和管理页。

### 第 2 步：生成合并订阅

1. 打开 Worker 地址（不用密码）
2. 按「生成新的订阅」，填名称并粘贴各机场的订阅链接（可用「批量粘贴」，一行一个）
3. 按「保存并生成链接」，再按「复制链接」或「一键导入 Clash」

## 客户端设置

1. 在 Clash Verge Rev / Mihomo Party / FlClash / Bettbox 等 mihomo 客户端，把合并订阅链接加成**远程订阅**，并打开自动更新
2. 对这个订阅添加**脚本覆写**：
   ```text
   https://raw.githubusercontent.com/AIsouler/MyClash/main/Script/Script.js
   ```
3. **关闭客户端的 DNS 覆写**（MyClash 脚本要求）

合并后的配置**不含** `proxy-providers`（MyClash 脚本遇到 `proxy-providers` 会报错），
并保留各机场的 `dns` / `hosts`，让脚本能处理机场的私有 DNS。

## 注意事项

- **TOKEN 等同密码**：拿到订阅链接的人就能用你的节点，也能编辑或删除这个订阅。外流时在管理页按「换 TOKEN」，旧链接会立即失效。
- **不需要管理密码**：Worker 没有「列出所有订阅」的功能，别人打开管理页只会看到他自己生成的订阅，看不到你的。
  管理页的清单记在你的浏览器里；换设备或清除浏览器数据后，用「导入 TOKEN」粘贴订阅链接就能找回来。
- **节点前缀**：每个机场的节点都会加上前缀（例如 `S1 | 香港 01`）避免重名。自定义前缀时，请避免
  「香港、日本、美国、HK、US、JP、机场、订阅」等字样，否则会影响 MyClash 脚本的地区分组和节点过滤。
- **抓取失败**：少数机场会屏蔽 Cloudflare 的 IP，或返回不支持的格式。失败的机场会被跳过，并在配置文件开头用注释标明；
  全部失败时 Worker 会返回错误，客户端会保留上一次成功的配置。建议优先使用机场提供的 Clash / Meta 订阅链接。
- **免费额度**：Cloudflare Workers 免费方案每天 10 万次请求、KV 每天 1000 次写入，个人使用绰绰有余。
- **更新程序**：Worker 和管理页都在本仓库，push 后 Cloudflare 会自动重新部署。

## 开发

```bash
npm install
npm test                                     # 单元测试
npx wrangler dev                             # 本机运行 Worker（含本机 KV）
```

| 路径 | 说明 |
| --- | --- |
| `GET /sub/<TOKEN>` | 合并后的订阅（mihomo YAML） |
| `POST /api/subs` | 添加，内容 `{ "name": "...", "sources": [{ "name": "", "url": "https://..." }] }` |
| `GET` / `PUT` / `DELETE /api/subs/<TOKEN>` | 查找、编辑、删除（持有 TOKEN 即可） |
| `POST /api/subs/<TOKEN>/rotate` | 换新 TOKEN |

## 致谢

- [AIsouler/MyClash](https://github.com/AIsouler/MyClash)：覆写脚本
- [Kwisma/cf-SubCloud](https://github.com/Kwisma/cf-SubCloud)：架构参考
