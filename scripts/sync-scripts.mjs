// 生成物（覆写脚本与规则集）都写到输出目录 OUT_DIR（默认 rules-out/），由 GitHub Actions 推到 rules 分支，不进 main：
//   script.js            ← 从 AIsouler/MyClash 抓 Script/Script.js（精简版，管理页默认），套用本项目的改动
//   script-full.js       ← 同上，Script/mihomoScript.js（全量版）
//   rules/sukka-reject.mrs ← Sukka 的 Reject Base 域名集（ruleset.skk.moe），用 mihomo 转成 mrs，
//                           换掉两个脚本「AdBlock」组原来的 category-ads
// 需要 mihomo（PATH 里，或用 MIHOMO 环境变量指定路径）。
// 上游改版导致找不到要改的位置时直接报错，不会写出半成品。用法：node scripts/sync-scripts.mjs
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const OUT_DIR = resolve(process.env.OUT_DIR || 'rules-out');
const UPSTREAM = 'https://raw.githubusercontent.com/AIsouler/MyClash/main/Script/';
const TARGETS = [
  { from: 'Script.js', to: 'script.js' },
  { from: 'mihomoScript.js', to: 'script-full.js' },
];

// Sukka 的 Reject Base 域名集（广告、跟踪、小米反诈 / 云扫描等，每天重新生成）只发布文本，
// 转成 mrs 放在 rules 分支，经 CDN 下载，替换「AdBlock」组原来的 category-ads（默认 REJECT）。
// 清单原文有 3 MB、约 14 万个域名，只留转出来的 mrs
const SUKKA_REJECT_URL = 'https://ruleset.skk.moe/Clash/domainset/reject.txt';
const SUKKA_MIN_DOMAINS = 50000; // 少于这个数说明上游改版或抓到的不是清单
export const SUKKA_RULESET = 'rules/sukka-reject'; // 相对 rules 分支根目录
export const SUKKA_RULESET_URL = `https://cdn.jsdmirror.com/gh/exusiai-team/MyClash@rules/${SUKKA_RULESET}.mrs`;

// 通用测速网址与间隔（groupBaseOption），对标 NIVA Network 订阅的「自动选择」组
export const BASE_TEST_URL = 'https://connectivitycheck.gstatic.com/generate_204';
export const BASE_TEST_INTERVAL = 300;

// 分流组的测速网址，基本取自 Bettbox 的服务检测（lib/common/media_unlock_checker.dart）；
// Bettbox 没检测的服务不列在这里，用通用测速网址 BASE_TEST_URL
export const TEST_URLS = {
  YouTube: 'https://www.youtube.com/premium',
  Google: 'https://www.google.com/generate_204',
  // Bettbox 用的 /cdn-cgi/trace 由 Cloudflare 边缘节点直接回应，只测到「节点 → 就近 Cloudflare」，
  // 到不了 Anthropic 源站，地区被封也照样 200；/v1/models 不带 key 由源站回 401，测的是 Claude Code 实际走的整条路径
  AI: 'https://api.anthropic.com/v1/models',
  GitHub: 'https://github.com/',
  Apple: 'https://gspe1-ssl.ls.apple.com/pep/gcc',
  // Bettbox 用的 http://91.108.56.100/ 不支持 keep-alive，unified-delay 的第二次请求常失败、延迟失准
  Telegram: 'https://api.telegram.org/',
  Steam: 'https://store.steampowered.com/',
  TikTok: 'https://perfops1.byteperf.com/500b-bench.jpg',
  Twitter: 'https://x.com/cdn-cgi/trace',
  Netflix: 'https://www.netflix.com/title/81280792',
  Spotify: 'https://www.spotify.com/signup',
  Crypto: 'https://www.coinbase.com/cdn-cgi/trace',
  PayPal: 'https://www.paypal.com/',
  EHentai: 'https://e-hentai.org/cdn-cgi/trace',
};

// 地区组（连同「<地区>-自动选择」）的测速网址；没列的用通用测速网址 BASE_TEST_URL
export const REGION_TEST_URLS = {
  // 台湾节点主要拿来用 Claude，按 Claude 的连通性挑节点
  台湾: TEST_URLS.AI,
};

// 「直连」组的测速网址：要有 IPv4 和 IPv6 地址，「仅IPv6」才测得通；
// 通用测速网址 connectivitycheck.gstatic.com 在国内 DNS 只有 IPv4 地址，「仅IPv6」解析不到会一直超时
export const DIRECT_TEST_URL = 'https://wifi.vivo.com.cn/generate_204';

const HUGGINGFACE_PROVIDER = `      // HuggingFace 也在 category-ai-!cn 里，用单独的规则集抢先分到「默认代理」
      huggingface: {
        ...ruleProviderCommonDomain,
        url: \`\${ruleSetBaseUrl}geosite/huggingface.mrs\`,
        path: './ruleset/huggingface.mrs',
        'path-in-bundle': 'geo/geosite/huggingface.mrs',
      },
`;

function replaceOnce(source, search, replacement, what) {
  const i = source.indexOf(search);
  if (i === -1 || source.indexOf(search, i + search.length) !== -1) {
    throw new Error(`找不到唯一的「${what}」，上游脚本可能改版了`);
  }
  return source.slice(0, i) + replacement + source.slice(i + search.length);
}

export function patchScript(source, file) {
  let s = source;
  s = replaceOnce(
    s,
    ' * 友情推荐',
    ` * 本文件由 exusiai-team/MyClash 的 scripts/sync-scripts.mjs 从 ${file} 生成（MIT License, Copyright (c) 2026 AIsouler），改动：
 * - 通用测速网址改为 connectivitycheck.gstatic.com/generate_204，测速间隔改为 300 秒
 * - 分流策略组使用各自服务的测速网址（参考 Bettbox 的服务检测），不再全部共用 groupBaseOption.url
 * - HuggingFace 用 bett-rules 的 huggingface 规则集分出来，不走「AI」组，改走「默认代理」
 * - 「AI」组默认选「台湾」，没有台湾节点时选「美国」
 * - 「台湾」地区组与「台湾-自动选择」用 Claude 的测速网址
 * - 「AdBlock」组的广告规则集由 category-ads 换成 Sukka 的 Reject Base（ruleset.skk.moe，转成 mrs，含小米反诈 / 云扫描等域名）
 * - 新增「IPv6」节点组（名称标有 IPv6 / v6，或 server 为 IPv6 地址的节点），并加进「默认代理」
 * - 「直连」组改用有 IPv6 地址的 vivo 测速网址，「仅IPv6」不再一直超时；默认选「IPv6优先」
 * - 日志级别改为 warning，不再逐条记录连接；本机 xray / sing-box 进程直连，不经节点再代理一次
 * - default-nameserver 与 proxy-server-nameserver 只用阿里、腾讯两个 DoH，测速时不再刷屏「operation was canceled」
 * - 地区组默认选「<地区>-自动选择」，「默认代理」默认选全局「自动选择」
 * - 开启 sniffer，绕过系统 DNS（浏览器安全 DNS、直连 IP）的连接也能按域名分流
 * - 广告规则排在国内直连前面，国内厂商的广告、统计与小米反诈等域名才拦得到
 * - 自动选择组不选 HTTP / SOCKS5 节点（多是公开代理），也不选高倍率与「勿跑大流量」节点
 * - 分流组都加上「直连」选项（原版只有 Apple、Steam 等少数几个）
 * - AI 链式代理：MyClash Worker 选的节点与整组走链式的地区组直接挂上新增的「AI链式代理」组中转，「AI」组默认选它们
 * 友情推荐`,
    '文件开头注释',
  );

  // 只在 serviceConfigs 里给分流组加 testUrl
  const start = s.indexOf('const serviceConfigs = [');
  const end = s.indexOf('\n];', start);
  if (start === -1 || end === -1) throw new Error('找不到 serviceConfigs，上游脚本可能改版了');
  let block = s.slice(start, end);
  for (const [name, url] of Object.entries(TEST_URLS)) {
    const line = `\n    name: '${name}',\n`;
    if (block.includes(line)) block = replaceOnce(block, line, `${line}    testUrl: '${url}',\n`, `${name} 分流组`);
  }
  block = replaceOnce(block, "      ai: {\n", `${HUGGINGFACE_PROVIDER}      ai: {\n`, 'AI 规则集');
  block = useSukkaReject(block);
  block = replaceOnce(block, "'RULE-SET,ai,AI'", "'RULE-SET,huggingface,默认代理', 'RULE-SET,ai,AI'", 'AI 规则');
  block = replaceOnce(
    block,
    `    name: 'AI',\n    testUrl: '${TEST_URLS.AI}',\n    baseOption: selectBaseOption,\n    defaultSelected: '美国',\n`,
    `    name: 'AI',\n    testUrl: '${TEST_URLS.AI}',\n    baseOption: selectBaseOption,\n    defaultSelected: '台湾',\n    fallbackSelected: '美国',\n`,
    'AI 默认选择',
  );
  s = s.slice(0, start) + block + s.slice(end);
  // 默认选的组不存在（订阅里没有台湾节点）时改选 fallbackSelected（美国），都没有才由客户端退回第一项
  s = replaceOnce(
    s,
    '    const selected =\n      svc.defaultSelected !== undefined && groupProxies.includes(svc.defaultSelected) ? svc.defaultSelected : undefined;\n',
    '    // 默认选的组不存在时改选 fallbackSelected（AI：没有台湾节点就选美国）\n' +
      '    const selected = [svc.defaultSelected, svc.fallbackSelected].find((name) => name !== undefined && groupProxies.includes(name));\n',
    '分流组默认选择代码',
  );
  s = setBaseTestOption(s);
  s = addRegionTestUrls(s);
  s = addIpv6Group(s);
  s = addDirectTestUrl(s);
  s = reduceMemory(s);
  s = useDohBootstrap(s);
  s = defaultToAuto(s);
  s = addSniffer(s);
  s = adBlockFirst(s);
  s = excludeFromAutoGroups(s);
  s = directForAllServices(s);
  s = addAiChain(s);

  return replaceOnce(
    s,
    '      ...(svc.icon && { icon: svc.icon }),\n      proxies: groupProxies,\n',
    '      ...(svc.icon && { icon: svc.icon }),\n      proxies: groupProxies,\n      // 分流组用各自服务的测速网址\n      ...(svc.testUrl && { url: svc.testUrl }),\n',
    '分流组生成代码',
  );
}

// 「AdBlock」组的 category-ads 换成 Sukka 的 mrs 规则集
const CATEGORY_ADS_PROVIDER =
  "      'category-ads': {\n" +
  "        ...ruleProviderCommonDomain,\n" +
  "        url: `${ruleSetBaseUrl}geosite/category-ads.mrs`,\n" +
  "        path: './ruleset/category-ads.mrs',\n" +
  "        'path-in-bundle': 'geo/geosite/category-ads.mrs',\n" +
  "      },\n";

export function useSukkaReject(source) {
  const provider = `      // Sukka 的 Reject Base（广告、跟踪、小米反诈 / 云扫描等），由本仓库转成 mrs
      'sukka-reject': {
        ...ruleProviderCommonDomain,
        url: '${SUKKA_RULESET_URL}',
        path: './ruleset/sukka-reject.mrs',
      },
`;
  const s = replaceOnce(source, CATEGORY_ADS_PROVIDER, provider, 'AdBlock 规则集');
  return replaceOnce(s, "rules: ['RULE-SET,category-ads,AdBlock'],", "rules: ['RULE-SET,sukka-reject,AdBlock'],", 'AdBlock 规则');
}

// groupBaseOption 改用 BASE_TEST_URL 与 BASE_TEST_INTERVAL
export function setBaseTestOption(source) {
  const start = source.indexOf('const groupBaseOption = {');
  const end = source.indexOf('\n};', start);
  if (start === -1 || end === -1) throw new Error('找不到 groupBaseOption，上游脚本可能改版了');
  let block = source.slice(start, end);
  block = block.replace(/\n  interval: \d+,\n/, `\n  interval: ${BASE_TEST_INTERVAL},\n`);
  block = block.replace(/\n  url: '[^']*',\n/, `\n  url: '${BASE_TEST_URL}',\n`);
  if (!block.includes(`interval: ${BASE_TEST_INTERVAL},`) || !block.includes(`url: '${BASE_TEST_URL}',`)) {
    throw new Error('找不到 groupBaseOption 的 interval 或 url，上游脚本可能改版了');
  }
  return source.slice(0, start) + block + source.slice(end);
}

// 地区组按 REGION_TEST_URLS 改用各自的测速网址，手动选择组与自动选择组都改
export function addRegionTestUrls(source) {
  const call = 'createRegionGroup(r.name, r.icon, regionGroups[r.name])';
  return replaceOnce(
    source,
    `.flatMap((r) => ${call});`,
    `.flatMap((r) => {
      // 部分地区组用各自的测速网址
      const testUrl = { ${Object.entries(REGION_TEST_URLS).map(([name, url]) => `${name}: '${url}'`).join(', ')} }[r.name];
      return ${call}.map((g) => (testUrl ? { ...g, url: testUrl } : g));
    });`,
    '地区组生成代码',
  );
}

// 「IPv6」节点组放在地区组之后、「其他节点」之前，跟地区组一样是 select 组，
// 所以会自动出现在「默认代理」、各分流组与「漏网之鱼」里
const IPV6_GROUP = `  // IPv6 节点：名称标有 IPv6 / v6，或 server 本身是 IPv6 地址，或强制只用 IPv6
  const ipv6NameRegex = /ipv6|(?<![a-z0-9])v6(?![a-z0-9])/i;
  const ipv6Proxies = [...filteredProxies, ...customProxies]
    .filter(
      (proxy) =>
        ipv6NameRegex.test(toMatchableName(proxy.name)) ||
        String(proxy.server ?? '').includes(':') ||
        proxy['ip-version'] === 'ipv6',
    )
    .map((proxy) => proxy.name);
  // 上游没有 IPv6 图标，Global.svg 已给 GLOBAL 组用，改用本仓库仿上游风格画的 public/icons/IPv6.svg
  if (ipv6Proxies.length > 0) {
    generatedRegionGroups.push(
      ...createRegionGroup('IPv6', 'https://cdn.jsdmirror.com/gh/exusiai-team/MyClash@main/public/icons/IPv6.svg', ipv6Proxies),
    );
  }

`;

export function addIpv6Group(source) {
  const anchor = "  if (otherProxies.length > 0) {\n    generatedRegionGroups.push(...createRegionGroup('其他节点'";
  return replaceOnce(source, anchor, IPV6_GROUP + anchor, '其他节点组生成代码');
}

// 「直连」组（极简模式与完整模式各一处）改用 DIRECT_TEST_URL，
// 并把「IPv6优先」排到最前（select 组默认选第一个，原版默认「双栈」）
export function addDirectTestUrl(source) {
  const re = /\n( +)name: '直连',\n\1proxies: \[\.\.\.directProxies\.map\(\(p\) => p\.name\)\],\n/g;
  const count = (source.match(re) || []).length;
  if (count !== 2) throw new Error(`「直连」组应有 2 处，找到 ${count} 处，上游脚本可能改版了`);
  const ipv6First =
    "[...directProxies.filter((p) => p['ip-version'] === 'ipv6-prefer'), ...directProxies.filter((p) => p['ip-version'] !== 'ipv6-prefer')]";
  return source.replace(
    re,
    (m, indent) => `\n${indent}name: '直连',\n${indent}proxies: ${ipv6First}.map((p) => p.name),\n${indent}url: '${DIRECT_TEST_URL}',\n`,
  );
}

// 减少 mihomo 内存与日志量：
// - info 级别会把每条连接写进日志（一晚数 MB），改成 warning 只留警告与错误
// - 本机的 xray / sing-box（如 v2rayN 的核心）自己会连节点，经 TUN 进来后直连即可，
//   不再经节点代理一次，避免连接数翻倍与无谓的拨号失败；放在最前面才不会先被其他规则抢走
const LOCAL_PROXY_CORE_RULES = `  // 本机其他代理核心（如 v2rayN 的 xray / sing-box）自己会连节点，直连即可，不再经节点代理一次
  'PROCESS-NAME,xray.exe,直连',
  'PROCESS-NAME,sing-box.exe,直连',
  'PROCESS-NAME,xray,直连',
  'PROCESS-NAME,sing-box,直连',

`;

export function reduceMemory(source) {
  let s = replaceOnce(source, "  newConfig['log-level'] = 'info';\n", "  newConfig['log-level'] = 'warning';\n", '日志级别');
  const anchor = "const prefixRules = [\n  // 规则集下载域名";
  return replaceOnce(s, anchor, `const prefixRules = [\n${LOCAL_PROXY_CORE_RULES}  // 规则集下载域名`, '前置规则');
}

// 上游 default-nameserver / proxy-server-nameserver 是「114 明文 UDP + DoT + DoH」三个一起竞速：
// 114 几乎总是先回，DoT 每次查询都新建连接、DoH 也来不及连上就被取消，
// 带 #DIRECT 的拨号经过 mihomo 的连接处理，每次取消都记一条 warning，测速时节点域名集中解析就成簇刷屏。
// 改成两个 DoH（连接可复用，连上后不再拨号）：本机实测同样 120 次查询，warning 由 18 条降到 0，中位延迟 48ms → 18ms
const DOH_BOOTSTRAP_DNS = "['https://223.5.5.5/dns-query#DIRECT', 'https://1.12.12.12/dns-query#DIRECT']";

export function useDohBootstrap(source) {
  let s = source.replace(/^const defaultDNS = \[[^\n]*\];$/m, `const defaultDNS = ${DOH_BOOTSTRAP_DNS};`);
  s = s.replace(/^const proxyServerDNS = \[[^\n]*\];$/m, `const proxyServerDNS = ${DOH_BOOTSTRAP_DNS};`);
  if ((s.match(new RegExp(`= ${DOH_BOOTSTRAP_DNS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};`, 'g')) || []).length !== 2) {
    throw new Error('找不到 defaultDNS 或 proxyServerDNS，上游脚本可能改版了');
  }
  return s;
}

// select 组默认选第一个节点，所以把自动选择排到最前：
// - 地区组（含 IPv6、其他节点）默认选「<地区>-自动选择」
// - 「默认代理」默认选全局的「自动选择」
export function defaultToAuto(source) {
  let s = replaceOnce(source, 'proxies: [...proxies, urlTestName],', 'proxies: [urlTestName, ...proxies],', '地区组节点顺序');
  s = replaceOnce(
    s,
    "proxies: [...allProxiesNames, ...(autoSelectGroupEnabled ? ['自动选择'] : [])],",
    "proxies: [...(autoSelectGroupEnabled ? ['自动选择'] : []), ...allProxiesNames],",
    '极简模式默认代理节点顺序',
  );
  return replaceOnce(
    s,
    'proxies: [...groupNamesOfSelect, ...baseGroupNames, ...customGroupNames],',
    "proxies: [...baseGroupNames.filter((n) => n === '自动选择'), ...groupNamesOfSelect, ...baseGroupNames.filter((n) => n !== '自动选择'), ...customGroupNames],",
    '默认代理节点顺序',
  );
}

// 上游没有 sniffer（mihomo 默认关闭）：fake-ip 只还原走系统 DNS 的连接，
// 浏览器的安全 DNS、自带 DoH 的 App、直接连 IP 的流量进来只有 IP，域名规则全部失效。
// 不改目标地址（override-destination: false），只拿嗅探到的域名来匹配规则
const SNIFFER = `  newConfig['sniffer'] = {
    enable: true,
    'force-dns-mapping': true,
    'parse-pure-ip': true,
    'override-destination': false,
    sniff: {
      HTTP: { ports: [80, '8080-8880'] },
      TLS: { ports: [443, 8443] },
      QUIC: { ports: [443, 8443] },
    },
    'skip-domain': ['Mijia Cloud', '+.push.apple.com'],
  };

`;

export function addSniffer(source) {
  return replaceOnce(source, "  newConfig['tun'] = {\n", `${SNIFFER}  newConfig['tun'] = {\n`, 'tun 设置');
}

// 上游的分流规则（含 AdBlock）都排在前置规则之后，而前置规则先把 geolocation-cn 直连了；
// geolocation-cn 按 baidu.com、miui.com 等整个域名后缀匹配，国内厂商的广告、统计与小米反诈等域名先被直连，到不了 AdBlock。
// 把 AdBlock 的规则搬到「私有网络直连」之后：从 functionalRules 里取，AdBlock 关闭或极简模式时就没有，不会指向不存在的组
const RULES_START = "  newConfig['rules'] = [\n    ...prefixRules,\n";
const AD_BLOCK_FIRST = `  // 广告规则排在国内直连前面，否则国内厂商的广告域名先被 geolocation-cn 直连
  const adBlockRules = functionalRules.filter((rule) => rule.endsWith(',AdBlock'));
  const afterPrivate = prefixRules.indexOf('RULE-SET,private,直连') + 1;
  newConfig['rules'] = [
    ...prefixRules.slice(0, afterPrivate),
    ...adBlockRules,
    ...prefixRules.slice(afterPrivate),
`;

export function adBlockFirst(source) {
  replaceOnce(source, "  // 私有网络直连\n  'RULE-SET,private,直连',\n", '', '私有网络直连规则');
  const s = replaceOnce(source, RULES_START, AD_BLOCK_FIRST, '规则组装代码');
  return replaceOnce(
    s,
    '    ...functionalRules,\n',
    '    ...functionalRules.filter((rule) => !adBlockRules.includes(rule)),\n',
    '分流规则',
  );
}

// 自动选择组（url-test）只看延迟：
// - 机场混进来的 HTTP / SOCKS5 节点多是公开代理，被选中就把流量交给陌生人
// - 高倍率与「勿跑大流量」节点被长期选中会很快耗光流量；倍率判断沿用上游「高倍率节点」组的正则。
//   「高倍率节点-自动选择」不排除倍率，不然整组都被排掉
// 排除后一个节点都不剩的组不加，免得组变空被 empty-fallback 设成 REJECT
const AUTO_GROUP_EXCLUDE = `
  // 自动选择组不选 HTTP / SOCKS5 节点（多是公开代理），也不选高倍率与「勿跑大流量」节点；排除后没有节点的组不加
  const proxyTypes = new Map(newConfig['proxies'].map((p) => [p.name, String(p.type).toLowerCase()]));
  const highRateRegex = rateRegionDefinitions.find((r) => r.name === highRateRegionName).regex;
  const autoExcludeRegex = new RegExp(\`\${highRateRegex.source}|勿跑大流量\`, 'i');
  for (const group of newConfig['proxy-groups']) {
    if (group.type !== 'url-test') continue;
    const proxies = group.proxies.filter((name) => !['http', 'socks5'].includes(proxyTypes.get(name)));
    if (proxies.length === 0) continue;
    group['exclude-type'] = 'DIRECT|Http|Socks5';
    if (group.name === \`\${highRateRegionName}-自动选择\`) continue;
    if (proxies.some((name) => !autoExcludeRegex.test(name))) group['exclude-filter'] = \`(?i)\${autoExcludeRegex.source}\`;
  }
`;

export function excludeFromAutoGroups(source) {
  replaceOnce(source, "const highRateRegionName = '高倍率节点';\n", '', '高倍率节点组名称');
  replaceOnce(source, '  {\n    name: highRateRegionName,\n    regex:', '', '高倍率节点正则');
  return replaceOnce(source, '    ...generatedRegionGroups,\n  ];\n', `    ...generatedRegionGroups,\n  ];\n${AUTO_GROUP_EXCLUDE}`, '策略组组装代码');
}

// 上游只给标了 direct 的分流组（Apple、Steam 等）加「直连」，其余分流组都补上，想直连时不用改规则；
// AdBlock（REJECT / PASS）与手动选择、自动选择不走这段，不受影响
export function directForAllServices(source) {
  const search = "...(svc.direct ? ['直连'] : [])";
  const count = source.split(search).length - 1;
  if (count !== 2) throw new Error(`分流组的「直连」选项应有 2 处，找到 ${count} 处，上游脚本可能改版了`);
  return source.replaceAll(search, "'直连'");
}

// AI 链式代理（做法同常见的「台湾家宽经香港中转」订阅）：直接给原节点挂 dialer-proxy，不复制节点、不多出组。
// mihomo 不允许分组设 dialer-proxy，所以「整组走链式」就是把组里每个节点都挂上：
// - MyClash Worker 单独勾的节点带着 config 里不会带出去的标记 proxy['myclash-ai-chain']；
//   config['myclash-ai-chain-groups'] 列出整组走链式的地区组（如「台湾」），组里的节点都挂上
// - 挂了中转的节点照样留在原来的组，哪个组选到都经中转；「AI」组默认选第一个整组走链式的地区组，
//   只勾了单个节点时把它们放在「AI」组最前面并设为默认
// - 「AI链式代理」组决定从哪里连到这些节点，默认选香港（客户端里改选后会记住），选「直连」就是不中转；
//   选项同「AI」组原本的选项，但拿掉连得到挂了中转节点的组，不会绕回自己
// - 自动选择组（url-test）里还有其他节点的，拿掉挂了中转的节点，其他流量不会被自动选到多绕一趟
export const AI_CHAIN_KEY = 'myclash-ai-chain';
export const AI_CHAIN_GROUPS_KEY = 'myclash-ai-chain-groups';
export const AI_CHAIN_GROUP = 'AI链式代理';
export const AI_CHAIN_RELAY = '香港';
const AI_CHAIN_READ = `  // MyClash Worker 传进来的 AI 链式代理：整组走链式的地区组
  const aiChainGroups = config['${AI_CHAIN_GROUPS_KEY}'] ?? [];

`;
const AI_CHAIN = `  // AI 链式代理：单独勾的节点与整组走链式的地区组里的节点直接挂上中转「${AI_CHAIN_GROUP}」
  const aiGroup = newConfig['proxy-groups'].find((g) => g.name === 'AI');
  const pickedNodes = newConfig['proxies'].filter((p) => p['${AI_CHAIN_KEY}']).map((p) => p.name);
  newConfig['proxies'] = newConfig['proxies'].map(({ ['${AI_CHAIN_KEY}']: _, ...p }) => p);
  const groups = newConfig['proxy-groups'];
  const groupByName = new Map(groups.map((g) => [g.name, g]));
  const chainRegions = aiChainGroups.filter((name) => groupByName.has(name));
  // 组里（含子组）的所有节点
  const nodesOf = (name, seen = new Set()) => {
    if (seen.has(name)) return [];
    seen.add(name);
    const g = groupByName.get(name);
    return g ? g.proxies.flatMap((n) => nodesOf(n, seen)) : [name];
  };
  const proxyNames = new Set(newConfig['proxies'].map((p) => p.name));
  const chained = new Set([...pickedNodes, ...chainRegions.flatMap((r) => nodesOf(r))].filter((n) => proxyNames.has(n)));
  if (chained.size && aiGroup) {
    newConfig['proxies'] = newConfig['proxies'].map((p) => (chained.has(p.name) ? { ...p, 'dialer-proxy': '${AI_CHAIN_GROUP}' } : p));
    for (const g of groups) {
      if (g.type !== 'url-test' || g.proxies.every((n) => chained.has(n))) continue;
      g.proxies = g.proxies.filter((n) => !chained.has(n));
    }
    const relayProxies = aiGroup.proxies
      .filter((name) => name !== '直连' && !nodesOf(name).some((n) => chained.has(n)))
      .concat('直连');
    groups.splice(groups.indexOf(aiGroup) + 1, 0, {
      ...selectBaseOption,
      name: '${AI_CHAIN_GROUP}',
      icon: \`\${iconBaseUrl}Bypass.svg\`,
      proxies: relayProxies,
      ...(aiGroup.url && { url: aiGroup.url }),
      ...(relayProxies.includes('${AI_CHAIN_RELAY}') && { 'default-selected': '${AI_CHAIN_RELAY}' }),
    });
    if (chainRegions.length) {
      aiGroup.proxies = [...chainRegions.filter((r) => !aiGroup.proxies.includes(r)), ...aiGroup.proxies];
      aiGroup['default-selected'] = chainRegions[0];
    } else {
      aiGroup.proxies = [...pickedNodes, ...aiGroup.proxies.filter((n) => !pickedNodes.includes(n))];
      aiGroup['default-selected'] = pickedNodes[0];
    }
    const globalProxies = groups.find((g) => g.name === 'GLOBAL')?.proxies;
    if (globalProxies?.includes('AI')) globalProxies.splice(globalProxies.indexOf('AI') + 1, 0, '${AI_CHAIN_GROUP}');
  }

`;

export function addAiChain(source) {
  const start = "  const newConfig = {};\n\n  const filteredProxies = filterAndNormalizeProxies(config);\n";
  const s = replaceOnce(source, start, AI_CHAIN_READ + start, 'main 开头');
  const anchor = "  newConfig['rule-providers'] = finalRuleProviders;\n";
  return replaceOnce(s, anchor, AI_CHAIN + anchor, '规则集组装代码');
}

// 精简版从全量版搬来「Apple」分流组（连同开关），放在「Telegram」之前，跟全量版顺序一致；
// 搬的是套用过改动的全量版，所以测速网址也一起带过来
export function addAppleGroup(lite, full) {
  const start = full.indexOf("  {\n    name: 'Apple',\n");
  const end = full.indexOf('\n  },\n', start);
  if (start === -1 || end === -1) throw new Error('全量版找不到「Apple」分流组，上游脚本可能改版了');
  const group = full.slice(start, end + '\n  },\n'.length);
  const option = full.match(/\n {2}Apple: true,[^\n]*\n/);
  if (!option) throw new Error('全量版找不到「Apple」开关，上游脚本可能改版了');

  let s = replaceOnce(lite, "  {\n    name: 'Telegram',\n", `${group}  {\n    name: 'Telegram',\n`, 'Telegram 分流组');
  s = replaceOnce(s, '\n  Telegram: true,', `${option[0].slice(0, -1)}\n  Telegram: true,`, 'Telegram 开关');
  return replaceOnce(s, ' * 友情推荐', ' * - 从全量版搬来「Apple」分流组\n * 友情推荐', '文件开头注释');
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`抓取 ${url} 失败：HTTP ${res.status}`);
  return res.text();
}

function convertToMrs(txt, mrs) {
  const mihomo = process.env.MIHOMO || 'mihomo';
  try {
    execFileSync(mihomo, ['convert-ruleset', 'domain', 'text', txt, mrs], { stdio: 'inherit' });
  } catch (err) {
    throw new Error(`用 ${mihomo} 转换 mrs 失败（需要安装 mihomo，或用 MIHOMO 环境变量指定路径）：${err.message}`);
  }
}

// 清单只在临时目录转成 mrs，再放进输出目录（清单开头的「Last Updated」不影响 mrs，内容没变 mrs 就一样）
async function syncSukkaRuleset() {
  const text = await fetchText(SUKKA_REJECT_URL);
  const count = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).length;
  if (count < SUKKA_MIN_DOMAINS) throw new Error(`Sukka 的清单只有 ${count} 个域名，上游可能改版了`);
  const dir = await mkdtemp(join(tmpdir(), 'sukka-reject-'));
  try {
    const txt = join(dir, 'reject.txt');
    await writeFile(txt, text);
    await mkdir(join(OUT_DIR, 'rules'), { recursive: true });
    convertToMrs(txt, join(OUT_DIR, `${SUKKA_RULESET}.mrs`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log(`Sukka Reject Base：${count} 个域名 → ${SUKKA_RULESET}.mrs`);
}

async function main() {
  // 先在内存里把两个脚本都改好，上游改版就在这里报错，不会留下写了一半的输出目录
  const [lite, full] = await Promise.all(
    TARGETS.map(async ({ from }) => patchScript(await fetchText(UPSTREAM + from), from)),
  );
  const outputs = [addAppleGroup(lite, full), full];
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  // SCRIPTS_ONLY=1：只生成两个脚本（「测试」流程用，测的是这次改动的补丁，不需要 mihomo）
  if (!process.env.SCRIPTS_ONLY) await syncSukkaRuleset();
  for (const [i, { from, to }] of TARGETS.entries()) {
    await writeFile(join(OUT_DIR, to), outputs[i]);
    console.log(`${from} → ${to}`);
  }
}

// 用 pathToFileURL 比较，Windows 的路径（E:\...）才对得上
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
