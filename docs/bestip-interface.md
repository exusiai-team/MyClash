# MyClash 需要 best-ip 提供的接口

目的：MyClash 每天把合并后的订阅交给 best-ip 实测。best-ip 回传每个节点的落地标签（家宽/机房、原生、落地国家、AI 可用性、风险），MyClash 按这些标签细化分组。节点名不改。

整体流程：

```
MyClash GitHub Action（每天）
  → POST best-ip /api/v1/classify（服务令牌鉴权）
  → 轮询状态直到 done
  → GET 结果 JSON
  → 写 MyClash KV：res:<token>
MyClash Worker 生成订阅时读 KV，给节点挂隐藏标签，交给覆写脚本分组
```

---

## 1. 鉴权

- 新增 `/api/v1/*` 机器接口。用 `Authorization: Bearer <BESTIP_SERVICE_TOKEN>` 鉴权，不走密码登录 cookie，也不做同源检查。
- 令牌放在 best-ip Worker 的 secret 里。MyClash 存到 Actions secret `BESTIP_SERVICE_TOKEN`。
- 同一个令牌同时只允许跑一个扫描。重复提交返回正在运行的那个 `scan_id`，不新开扫描。

## 2. 接口

### 2.1 创建扫描

`POST /api/v1/classify`

```json
{
  "request_id": "myclash-<token前8位>-20261120",
  "label": "myclash:<token前8位>",
  "subscription_url": "https://<myclash>/sub/<token>",
  "profile": "classify",
  "reuse_hours": 20
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `request_id` | 是 | 幂等键。同一个 id 重复提交返回同一个扫描 |
| `label` | 是 | 区分不同订阅组，供 `latest` 查询用 |
| `subscription_url` | 二选一 | Clash YAML 订阅地址，内容里有顶层 `proxies` |
| `subscription_yaml` | 二选一 | 直接内联 YAML 文本（≤ 5 MB），不用对外暴露订阅地址 |
| `profile` | 否 | `classify`（见 §4）或 `full`（现有完整扫描）。默认 `full` |
| `reuse_hours` | 否 | 节点指纹（§3.1）不变，且距上次扫描在 N 小时内的，直接复用上次结果，不重新测。默认 0 |

返回 `202`：

```json
{ "scan_id": "…", "status": "queued", "status_url": "/api/v1/classify/…", "result_url": "/api/v1/classify/…/result" }
```

### 2.2 查询状态

`GET /api/v1/classify/{scan_id}`

```json
{ "scan_id": "…", "status": "queued|running|done|failed", "progress": { "done": 120, "total": 300 }, "error": null }
```

### 2.3 取结果

`GET /api/v1/classify/{scan_id}/result`

- 直接返回 `application/json`（可以 gzip），不要 ZIP artifact、签名 URL 那一套。
- 结果至少保留 7 天。
- 只有 `status = done` 才能取，否则返回 `409`。

### 2.4 取某个 label 的最近一次结果

`GET /api/v1/classify/latest?label=myclash:<token前8位>`

返回该 label 最近一次 `done` 的结果，格式同 §2.3。MyClash 某次扫描失败时，用它兜底拿上一次的数据。

## 3. 结果格式

```json
{
  "schema_version": 1,
  "scan_id": "…",
  "label": "myclash:abcd1234",
  "started_at": "2026-11-20T19:17:00Z",
  "finished_at": "2026-11-20T19:41:12Z",
  "input_sha256": "…",
  "node_count": 300,
  "nodes": [ /* §3.2 */ ]
}
```

### 3.1 节点身份（重要）

每条结果必须同时给出：

- `name`：与输入 YAML 里的 `name` **逐字节一致**。不要 trim，不要去 emoji，也不要做 Unicode 规范化。MyClash 用它做主键。
- `index`：节点在输入 `proxies` 里的下标，从 0 开始。
- `fingerprint`：节点改名后仍能对上的备用键，算法固定为：

  ```
  sha256( type + "|" + server + "|" + port + "|" + (uuid ?? password ?? "") ) 的十六进制前 16 位
  ```

  `server` 和 `port` 取输入原值，不解析域名。MyClash 会用同样的算法计算。

输入里重名的节点要逐条返回，不要合并。

### 3.2 单个节点

```json
{
  "name": "🇭🇰 香港 01",
  "index": 0,
  "fingerprint": "3f9a1c0d2b7e4a51",
  "status": "ok",
  "reason": null,
  "checked_at": "2026-11-20T19:20:03Z",
  "reused": false,

  "exit_ip": "203.0.113.7",
  "country_code": "JP",
  "reg_country_code": "US",

  "usage_type": "residential",
  "usage_votes": { "ipx": "residential", "ipqs": "residential", "ipure": "business" },
  "native": true,

  "asn": 4713,
  "as_org": "NTT Communications",

  "score": 82,
  "risk": { "proxy": false, "vpn": false, "tor": false, "abuser": false },

  "ai": { "openai": "ok", "claude": "unknown", "gemini": "unknown" },

  "same_exit": ["🇯🇵 日本 03"]
}
```

| 字段 | 取值 | MyClash 的用途 |
|---|---|---|
| `status` | `ok` / `failed` / `skipped` | 只有 `ok` 的节点会用来分组 |
| `reason` | `failed`/`skipped` 时填原因（`timeout`、`unsupported_type`、`rate_limited`…） | 排查 |
| `reused` | bool | 结果是否来自 `reuse_hours` 复用 |
| `exit_ip` | 落地 IP | 展示、排查 |
| `country_code` | 落地 IP 的地理国家，ISO 3166-1 alpha-2 大写，未知为 `null` | 修正地区分组 |
| `reg_country_code` | IP 注册国家 | 辅助判断原生 |
| `usage_type` | `residential` / `mobile` / `business` / `hosting` / `education` / `government` / `null` | 家宽、机房判定。**不要合并 mobile**，原样给出 |
| `usage_votes` | 各数据源各自的判定，拿不到的源省略 | MyClash 可以要求多个源一致才算 |
| `native` | `true`（原生）/ `false`（广播）/ `null` | 原生 IP 分组 |
| `asn`、`as_org` | 整数、字符串 | 展示 |
| `score` | 0–100 整数，越高越干净；注明采用哪个源（建议 ipx `health.score`），无数据为 `null` | 分档 |
| `risk` | 各项 bool 或 `null` | 排除高风险节点 |
| `ai` | 每个服务取 `ok` / `blocked` / `unknown`；没测的给 `unknown` | AI 分组只放实测可用的节点 |
| `same_exit` | 与本节点落地 IP 相同的其他节点名 | 去重、展示 |

约定：

- 枚举值只用上表列出的值。拿不到数据就填 `null`，不要省略字段。
- 结果里**不要出现**任何节点凭据（uuid、password、私钥等）。
- 新增字段可以随时加，但改名或改语义要升 `schema_version`。

## 4. `classify` 轻量档

MyClash 只需要 §3.2 的字段，希望每天扫几百个节点能在 30 分钟内跑完：

- 只做：落地 IP 探测、网络身份（ipx → ipqs → ipure → coffee）、原生判定、风险标记、AI 可用性检测。
- 跳过：port_scan、global_ping、related_domains、蜜罐和流量画像等重探测。
- 多个节点落地 IP 相同时，只查一次第三方接口，结果共用（现有 `ip_cache` 已经这样做）。
- 遇到 429 时，这个源记为缺失，接着用下一个源，不要让整个节点失败。

## 5. 安全

- `subscription_url` 本身带有 MyClash 令牌。只在本次扫描期间使用，不写日志，不进结果，也不长期存储。
- 现有的 Durable Object 暂存加 OIDC 领取机制可以沿用。

## 6. 可选：本地 CLI

接口不可用时，MyClash 可以在自己的 Action 里直接跑 CLI，输出格式和 §3 完全一致：

```
uv run python -m app.classify --input sub.yaml --output result.json [--profile classify] [--reuse result-prev.json]
```

---

## 附：MyClash 这边会怎么用（供参考，不需要 best-ip 实现）

1. Action 拿到结果后，按 name 建索引，写进 KV `res:<token>`。
2. Worker 生成订阅时，先按 `name` 匹配，匹配不上再用 `fingerprint`。匹配上的节点挂 `proxy._bestip = {…}`，在执行覆写脚本前完成，节点名不变。
3. 覆写脚本经补丁后，按标签细化分组：
   - 家宽组：正则命中 ∪ `usage_type ∈ {residential, mobile}`（mobile 是否计入可以配置）。
   - 可选剔除：名字写了家宽，但 `usage_type = hosting` 的节点。
   - 原生 IP 组：`native = true`。
   - 地区组：`country_code` 与名字推断的地区冲突时，以实测结果为准（可配置）。
   - AI 组：只放 `ai.* = ok` 的节点。
4. 输出 YAML 前删掉 `_bestip`。没有扫描数据的节点按原正则逻辑归类。
