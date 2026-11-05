# 功能与来源对照

本仓库输出的配置由三层组成，每层的功能来自不同地方：

```
机场订阅 ──► Worker 合并（全部是本仓库写的）
          ──► 覆写脚本（AIsouler/MyClash 原版 + 本仓库的补丁）
          ──► 规则集（bett-rules、Sukka 等第三方数据，客户端自己下载）
```

来源标记：

| 标记 | 含义 | 在哪里改 |
| --- | --- | --- |
| **上游** | [AIsouler/MyClash](https://github.com/AIsouler/MyClash)（MIT）原版脚本就有，本仓库没动 | 跟着上游每天同步，不用管 |
| **本仓库** | 本仓库新增或改过 | Worker：`src/`；覆写脚本：`scripts/sync-scripts.mjs` 里括号注明的函数；小火箭：`public/shadowrocket.conf` |
| **数据** | 第三方数据，本仓库只是引用或转换格式 | 见文末「第三方数据」 |

上游改版导致补丁找不到位置时，同步流程直接失败、不推送（见 README「覆写脚本」），所以下表「本仓库」的改动要么全部生效，要么维持上一版。

## 1. Worker：合并订阅（全部是本仓库写的）

| 功能 | 说明 | 位置 |
| --- | --- | --- |
| 合并订阅 | 多个机场订阅合成一个链接，节点取并集，流量加总、到期日取最早 | `src/parse.js` |
| 缓存 | 每个机场一份 KV 缓存，30 分钟内直接用；更旧的才连机场，最多等 2.5 秒，超时先用旧缓存、背景更新 | `src/worker.js` |
| 代抓缓存 | 机场屏蔽 Cloudflare（HTTP 403）时由 GitHub Actions 每 24 小时代抓，写进 KV | `scripts/refresh-cache.mjs` |
| 到期屏蔽 | `subscription-userinfo` 显示已到期或流量用完的机场整个跳过，流量、到期日不计入 | `src/parse.js` |
| 节点前缀 | 机场简称（文件名 / 域名缩写，去掉会让脚本误判的字）、S1/S2 编号或不加前缀 | `src/parse.js` |
| 倍率标注 | 认得 `2x`、`×1.5`、`2倍` 等写法，统一改成 `前缀 \| 2x \| 原名`，1 倍不标 | `src/parse.js` |
| 去重 | 除名称外设置完全相同的节点只留第一个，信息节点不参与比较 | `src/parse.js` |
| 节点筛选 | 全局 / 每个机场的倍率门槛，再逐个排除节点；被排除节点的 `dialer-proxy` 依赖者一并去掉 | `src/parse.js`、`public/index.html` |
| 服务端覆写 | `?script=lite\|full` 在 Worker 里直接执行覆写脚本，客户端不用再加脚本 | `src/worker.js`、`scripts/build-overrides.mjs` |
| AI 链式代理（传参） | 订阅记录里存勾选的节点与整组；输出时给节点加 `myclash-ai-chain` 标记、整组放进 `config['myclash-ai-chain-groups']`，脚本读完就删 | `src/worker.js` |
| 自动导入 | 浏览器打开订阅链接或按客户端「首页」跳到管理页并导入 | `src/worker.js`、`public/index.html` |
| 多种格式 | mihomo / Clash YAML，base64 的 ss / vmess / vless / trojan / hysteria2 | `src/parse.js` |
| 精简 YAML 输出 | 自带 `dumpYaml`，比 js-yaml 快 4～6 倍，不超过免费方案 10 ms CPU | `src/parse.js` |
| 保留机场 DNS | 合并结果保留各机场的 `dns` / `hosts`，交给脚本挑出节点域名要用的私有 DNS（见 3.1） | `src/parse.js` |

## 2. 覆写脚本：策略组与节点

### 2.1 上游原有

| 功能 | 说明 |
| --- | --- |
| 节点清理 | 去掉零宽 / 不可见字符、补地区国旗、去重；剔除名称含「官网、剩余、到期、群…」的信息节点；`dialer-proxy` 指向被改名或删除的节点时自动修正 |
| 地区组 | 香港、日本、美国、新加坡、台湾，按名称正则归组，各带「<地区>-自动选择」 |
| 倍率组 | 低倍率节点、高倍率节点（按名称里的倍率字样） |
| 家宽节点组 | 名称含家宽、住宅、原生 IP、ISP 等 |
| 其他节点组 | 不属于任何地区的节点 |
| 基础组 | 手动选择、自动选择（全量版另有负载均衡） |
| 分流组 | 精简版：Google、AI、Telegram、Steam、AdBlock；全量版另有 FCM、YouTube、GitHub、Microsoft、Apple、TikTok、Twitter、Meta、Line、Netflix、Emby、PikPak、Spotify、Crypto、PayPal、Patreon、EHentai |
| 默认代理 / 漏网之鱼 / GLOBAL | 未命中分流规则的海外流量走「默认代理」，最后兜底走「漏网之鱼」 |
| 直连组 | 双栈、IPv4优先、IPv6优先、仅IPv4、仅IPv6 五个 direct 节点 |
| 开关 | 极简国内外分流模式、屏蔽代理 QUIC、代理 IPv4 / IPv6 优先、过滤高 / 低倍率、过滤非地区节点、自定义节点、链式代理（自定义节点当落地）等，见脚本开头 `ruleOptionsEnable`（服务端覆写用默认值） |
| 其他设置 | `mixed-port: 7890`、`unified-delay`、`tcp-concurrent`、`find-process-mode: strict`、`store-selected`、`store-fake-ip`、NTP（阿里云）、TUN（`stack: mips`、`auto-route`、`strict-route`、`auto-redirect`、劫持 53 端口）、zashboard 面板 |

### 2.2 本仓库的改动

| 改动 | 原版 | 现在 | 补丁函数 |
| --- | --- | --- | --- |
| 通用测速 | Apple 测速网址、600 秒 | `connectivitycheck.gstatic.com/generate_204`、300 秒 | `setBaseTestOption` |
| 分流组测速 | 全部共用通用测速网址 | 各用自己服务的网址（数据：Bettbox 服务检测）；AI 用 `api.anthropic.com/v1/models`，Telegram 用 `api.telegram.org` | `TEST_URLS`、`patchScript` |
| 台湾组测速 | 通用测速网址 | 同 AI 组，按 Claude 连通性挑节点 | `addRegionTestUrls` |
| 直连组测速与默认 | 通用测速网址，默认「双栈」 | vivo 测速网址（有 IPv6 地址），默认「IPv6优先」 | `addDirectTestUrl` |
| HuggingFace | 在「AI」组里 | 用 bett-rules `huggingface` 规则集抢先分到「默认代理」 | `patchScript` |
| AI 默认选择 | 美国 | 台湾，没有台湾节点选美国 | `patchScript` |
| 分流组「直连」 | 只有 Apple、Steam 等少数几个 | AdBlock 以外全部都有 | `directForAllServices` |
| 精简版 Apple 组 | 只有全量版有 | 精简版也有 | `addAppleGroup` |
| IPv6 节点组 | 无 | 名称含 IPv6 / v6、server 是 IPv6 或 `ip-version: ipv6` 的节点，附自动选择组，图标 `public/icons/IPv6.svg` | `addIpv6Group` |
| 默认选自动选择 | 地区组默认选第一个节点，默认代理默认选第一个地区 | 地区组默认「<地区>-自动选择」，默认代理默认全局「自动选择」 | `defaultToAuto` |
| 自动选择组排除 | 只排除 DIRECT | 另排除 HTTP / SOCKS5、高倍率与「勿跑大流量」节点；排除后为空的组不排除 | `excludeFromAutoGroups` |
| AI 链式代理 | 无（上游的链式代理只给自定义节点用） | 新增「AI链式代理」组，Worker 传入的节点与整组挂上中转；挂了中转的节点从其他组拿掉，防止绕回崩溃 | `addAiChain` |
| 日志级别 | info | warning | `reduceMemory` |
| 本机代理核心直连 | 无 | xray / sing-box 进程最先直连 | `reduceMemory` |
| sniffer | 关闭 | 开启，嗅探 HTTP / TLS / QUIC，只拿域名匹配规则 | `addSniffer` |
| 广告规则 | category-ads，排在国内直连之后 | Sukka Reject Base（域名转 mrs + 关键词 / 通配 / IP 的 classical 规则集）与 Sukka 的 PCDN 清单，排在「私有网络直连」之后、国内直连之前 | `useSukkaReject`、`adBlockFirst` |
| DNS 引导 | 见第 3 节 | 见第 3 节 | `useDohBootstrap` |

## 3. DNS

### 3.1 现在输出的设置

机场的 `dns` 里没有节点专用 DNS 时，`?script=lite|full` 输出的 `dns` 与 `hosts` 就是下面这样（精简版、全量版相同）；行尾注释是来源：

```yaml
dns:
  enable: true                       # 上游
  ipv6: true                         # 上游
  use-hosts: true                    # 上游
  use-system-hosts: true             # 上游
  cache-algorithm: arc               # 上游
  enhanced-mode: fake-ip             # 上游
  fake-ip-range: 198.18.0.1/15       # 上游
  fake-ip-range6: 2001:2::1/48       # 上游
  fake-ip-filter:                    # 上游：这些域名回真 IP
    - rule-set:private
    - rule-set:fakeip_filter
    - rule-set:cn
  default-nameserver:                # 本仓库（原版：114 明文 + 阿里 DoT + 腾讯 DoH）
    - https://223.5.5.5/dns-query#DIRECT
    - https://1.12.12.12/dns-query#DIRECT
  proxy-server-nameserver:           # 本仓库（原版：114 明文 + 阿里 DoT + doh.pub）
    - https://223.5.5.5/dns-query#DIRECT
    - https://1.12.12.12/dns-query#DIRECT
  nameserver:                        # 上游
    - https://cloudflare-dns.com/dns-query#默认代理
    - https://dns.google/dns-query#默认代理
  nameserver-policy:                 # 上游
    rule-set:private: system
    rule-set:douyin: [180.184.1.1, 180.184.2.2]
    rule-set:cn: [223.5.5.5#DIRECT, 119.29.29.29#DIRECT]
  direct-nameserver: [223.5.5.5#DIRECT, 119.29.29.29#DIRECT]   # 上游
  direct-nameserver-follow-policy: true                         # 上游
hosts:                               # 上游；本仓库删掉了用不到的 doh.pub
  cloudflare-dns.com: [1.1.1.1, 1.0.0.1]
  dns.google: [8.8.8.8, 8.8.4.4]
  services.googleapis.cn: services.googleapis.com   # Google Play 下载
  +.mcdn.bilivideo.com: [0.0.0.0]                   # 以下 4 条屏蔽 B 站 PCDN
  +.mcdn.bilivideo.cn: [0.0.0.0]
  +.edge.mountaintoys.cn: [0.0.0.0]
  +.h2.smtcdns.net: [0.0.0.0]
```

机场订阅自带 DNS 时，上游还会多做两件事（Worker 合并时保留了机场的 `dns` / `hosts`，所以拿得到）：

- `proxy-server-nameserver-policy`：从机场 `dns` 里挑出解析节点域名用的私有 DNS（阿里、腾讯、Google 等公共 DNS 不算），只用在节点域名上；机场 `fake-ip-filter` 里跟节点域名有关的条目并进 `fake-ip-filter`
- 机场 DNS 是本机监听的写法时，直接按机场 `hosts` 改写节点 server

### 3.2 每种查询用哪个 DNS

| 查询 | 用哪个 | 经过 |
| --- | --- | --- |
| 私有域名（`rule-set:private`） | 系统 DNS | 直连 |
| 国内域名（`rule-set:cn`，约 10.7 万条），系统查到就回真 IP | 阿里 `223.5.5.5`、腾讯 `119.29.29.29`（UDP） | 直连 |
| 抖音 | 火山引擎 `180.184.1.1`、`180.184.2.2` | 直连 |
| 其他域名，系统来查 | 不查，直接回假 IP；连接按域名走规则，走代理时由节点那边解析 | — |
| 其他域名，规则走到 IP 规则还没命中（见第 5 节） | Cloudflare、Google DoH | 经「默认代理」 |
| 规则判为直连的连接，要拿真实 IP | 跟 `nameserver-policy` 一样（`direct-nameserver-follow-policy`），没命中就用阿里、腾讯 UDP | 直连 |
| 节点的服务器域名 | 机场的私有 DNS（有的话），否则阿里、腾讯 DoH | 直连 |
| DNS 服务器本身的域名（`cloudflare-dns.com`、`dns.google`） | 先查 `hosts`（写死了 IP）；查不到才用 `default-nameserver` | 直连 |
| 浏览器安全 DNS、App 自带 DoH、直接连 IP | 不经过 mihomo 的 DNS；sniffer 从 TLS / HTTP / QUIC 里取出域名再走规则 | — |

### 3.3 本仓库改了什么、为什么

- `default-nameserver` / `proxy-server-nameserver` 改成两个 DoH：原版 114 明文总是先回，DoT / DoH 连接还没建好就被取消，每次记一条 `dial DIRECT ... operation was canceled`，测速时节点域名集中解析就成簇刷屏。DoH 连接可复用，本机实测同样 120 次查询，warning 由 18 条降到 0，中位延迟 48 ms → 18 ms（`useDohBootstrap`）
- 删掉 `hosts` 里的 `doh.pub`：只有原版的 `proxy-server-nameserver` 用它，改成用 IP 的 DoH 后用不到了（`useDohBootstrap`）
- 开启 sniffer（`addSniffer`）：`force-dns-mapping`、`parse-pure-ip`，`override-destination: false`（只拿域名匹配规则，不改目标地址），跳过 `Mijia Cloud` 与 `+.push.apple.com`

国内 DNS（`nameserver-policy`、`direct-nameserver`）沿用原版的 UDP：一个包就回，取消也不会记 warning，换成 DoH 只多一点防运营商劫持 53 端口的好处。

## 4. 规则集

除 `sukka-reject-classical` 外都是 `format: mrs`；全部 `interval: 86400`（每天更新），客户端经 `cdn.jsdmirror.com` 下载（规则里先直连这个域名，避免鸡生蛋）。大小为 2026-11 的约值。

| 规则集 | 内容 | 用途 | 来源 |
| --- | --- | --- | --- |
| `private`、`private_ip` | 私有网络 | 直连；DNS 交给系统 | 上游（数据：bett-rules） |
| `geolocation-cn` | 国内常用域名，约 5,400 条、34 KB | 直连 | 上游（数据：bett-rules） |
| `cn` | 国内域名大表（含 `.cn` 与 dnsmasq-china-list），约 10.7 万条、500 KB | **只用于 DNS**：`fake-ip-filter`、`nameserver-policy` | 上游（数据：bett-rules） |
| `games_cn`、`synology`、`apple_cn`、`microsoft_cn` | 国内可直连的游戏下载、群晖、苹果、微软 | 直连 | 上游（数据：bett-rules） |
| `geolocation-!cn` | 海外域名，约 3.5 万条、220 KB | 默认代理 | 上游（数据：bett-rules） |
| `cn_ip` | 国内 IP | 兜底直连 | 上游（数据：bett-rules） |
| `fakeip_filter` | 不能给假 IP 的域名（NTP、连通性检测等） | DNS | 上游（数据：bett-rules） |
| `douyin` | 抖音 | DNS 走火山引擎 | 上游（数据：bett-rules） |
| 各分流组的 geosite / geoip | Google、AI、Telegram… | 对应分流组 | 上游（数据：bett-rules） |
| `huggingface` | HuggingFace | 默认代理（抢在 AI 前面） | **本仓库**（数据：bett-rules） |
| `sukka-reject` | Sukka Reject Base 的域名集 `domainset/reject`，加上 `non_ip/reject` 与 `non_ip/reject-no-drop`（PCDN）里的 DOMAIN / DOMAIN-SUFFIX，约 14.8 万条；转成 mrs 约 1.4 MB | AdBlock（默认 REJECT） | **本仓库**每天用 mihomo 转换，放 `rules` 分支（数据：Sukka） |
| `sukka-reject-classical` | 同上两份 non_ip 清单里 mrs 放不下的：约 146 条关键词（`adserver`、`umeng`、`admob`…）、22 条通配（`ads-*.tiktok.com`）、51 条 IP 段；classical 文本，约 7 KB | AdBlock，规则带 `no-resolve` | **本仓库**每天生成，放 `rules` 分支（数据：Sukka） |

原版的 `category-ads`（约 15 KB）被换掉，不再下载。

Sukka 的清单没有全取：

- 不取 `non_ip/reject-drop`：里面有极光（jpush）、个推（getui）等推送 SDK，屏蔽后国内 App 会收不到通知
- 不取 `ip/reject`：大多是运营商劫持「查无此域名」时回的 IP（本配置用公共 DNS，碰不到）与僵尸网络控制端 IP，跟广告无关；其中的 IP-ASN 规则 mrs 也放不下
- 不取 `domainset/reject_extra`：多 8 万条，误杀风险更高

`sukka-reject-classical` 里有 IP 规则，又排在国内直连前面，所以规则带 `no-resolve`：只拦本来就是 IP 的连接，不会让每个域名连接走到这里都先解析一次。

Sukka 也拦部分 AI 与 Google 的遥测域名（如 `statsig.anthropic.com`、`bzr.openai.com`、`gvt2.com`），AdBlock 排在 AI 规则前面，这些一定会被拒绝。碰到 App 异常时，把 AdBlock 组改选 `PASS` 试试。

## 5. 规则顺序

从上到下匹配，括号是来源：

1. xray / sing-box 进程 → 直连（本仓库）
2. `cdn.jsdmirror.com` → 直连（上游）
3. `private` → 直连（上游）
4. `sukka-reject`、`sukka-reject-classical`（`no-resolve`）→ AdBlock（本仓库：换了规则集，也从分流规则搬到这里）
5. `geolocation-cn`、`games_cn`、`synology`、`apple_cn`、`microsoft_cn` 与几个固定域名 → 直连（上游）
6. 屏蔽代理 QUIC（上游，默认关闭）
7. `huggingface` → 默认代理（本仓库）
8. 各分流组域名规则（上游）
9. `geolocation-!cn` → 默认代理（上游）
10. 各分流组 IP 规则（上游）
11. `cn_ip`、`private_ip` → 直连（上游）
12. `MATCH` → 漏网之鱼（上游；极简模式为默认代理）

第 10 条起是 IP 规则：域名走到这里还没命中，mihomo 会先解析出 IP。`cn` 里的域名经阿里、腾讯解析，很快；两张表都没有的域名经「默认代理」查 Cloudflare / Google DoH，第一次访问会慢一点，之后有缓存。

## 6. iPhone 小火箭（本仓库）

`public/shadowrocket.conf` 手写，对标精简版，不跟上游同步：地区组两层（手选 / 自动选择）、Google、AI、Apple、Telegram、Steam、AdBlock、漏网之鱼，测速网址同精简版；AI 默认「台湾优先」fallback 组。规则集用 blackmatrix7 的 Shadowrocket `.list`（小火箭读不了 mrs），没有 HuggingFace 分流、不做 AI 链式代理。

## 7. 自动化（本仓库）

| 流程 | 内容 |
| --- | --- |
| 同步上游覆写脚本（每天 UTC+8 04:00） | 抓上游两个脚本套补丁、转换 Sukka 规则集，测试通过才强制推到 `rules` 孤儿分支；脚本有变化时调 Deploy Hook 重新部署 |
| 代抓订阅缓存（每 24 小时） | 非 Cloudflare IP 代抓机场订阅写进 KV |
| 测试 | PR 与 `main` 有更新时跑单元测试与 `wrangler deploy --dry-run` |
| 依赖更新 | Dependabot 每月合成一个 PR，测试通过自动合并 |

## 第三方数据

| 来源 | 用在哪里 | 许可 |
| --- | --- | --- |
| [AIsouler/MyClash](https://github.com/AIsouler/MyClash) | 覆写脚本本体、图标 | MIT（`licenses/AIsouler-MyClash.txt`） |
| [appshubcc/bett-rules](https://github.com/appshubcc/bett-rules) | Sukka 以外的全部 mrs 规则集 | 见原仓库 |
| [Bettbox](https://github.com/appshubcc/Bettbox) | 分流组测速网址（服务检测） | 见原仓库 |
| [SukkaW/Surge](https://github.com/SukkaW/Surge)（ruleset.skk.moe） | `sukka-reject` 广告、跟踪、小米反诈域名 | AGPL-3.0（数据） |
| [blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script) | 小火箭规则集 | 见原仓库 |
| [Kwisma/cf-SubCloud](https://github.com/Kwisma/cf-SubCloud) | Worker 架构参考 | 见原仓库 |
