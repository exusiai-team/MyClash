// 从 AIsouler/MyClash 抓精简版与全量版覆写脚本，套用本项目的改动后写进 public/：
//   public/script.js       ← Script/Script.js（精简版，管理页默认）
//   public/script-full.js  ← Script/mihomoScript.js（全量版）
// 同时抓 LoopDns/Fuck-you-MIUI 的 hosts 清单，用 mihomo 转成 public/rules/fuck-you-miui.mrs，加进两个脚本的「AdBlock」组。
// 需要 mihomo（PATH 里，或用 MIHOMO 环境变量指定路径）。
// 上游改版导致找不到要改的位置时直接报错，不会写出半成品。用法：node scripts/sync-scripts.mjs
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const UPSTREAM = 'https://raw.githubusercontent.com/AIsouler/MyClash/main/Script/';
const TARGETS = [
  { from: 'Script.js', to: 'public/script.js' },
  { from: 'mihomoScript.js', to: 'public/script-full.js' },
];

// LoopDns/Fuck-you-MIUI 的 hosts 屏蔽清单（小米系统跟踪器、广告与内置 SDK），
// 转成 mrs 规则集放在本仓库，经 CDN 下载，加进「AdBlock」组（默认 REJECT）
const MIUI_HOSTS_UPSTREAM = 'https://raw.githubusercontent.com/LoopDns/Fuck-you-MIUI/main/';
const MIUI_HOSTS_FILES = ['MIhosts', 'Fhosts'];
export const MIUI_RULESET = 'public/rules/fuck-you-miui';
const MIUI_RULESET_URL = `https://cdn.jsdmirror.com/gh/exusiai-team/MyClash@main/${MIUI_RULESET}.mrs`;

// 通用测速网址与间隔（groupBaseOption），对标 NIVA Network 订阅的「自动选择」组
export const BASE_TEST_URL = 'https://connectivitycheck.gstatic.com/generate_204';
export const BASE_TEST_INTERVAL = 300;

// 分流组的测速网址，全部取自 Bettbox 的服务检测（lib/common/media_unlock_checker.dart）；
// Bettbox 没检测的服务不列在这里，用通用测速网址 BASE_TEST_URL
export const TEST_URLS = {
  YouTube: 'https://www.youtube.com/premium',
  Google: 'https://www.google.com/generate_204',
  AI: 'https://api.anthropic.com/cdn-cgi/trace',
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

const HUGGINGFACE_PROVIDER = `      // HuggingFace 也在 category-ai-!cn 里，用单独的规则集抢先分到「默认代理」
      huggingface: {
        ...ruleProviderCommonDomain,
        url: \`\${ruleSetBaseUrl}geosite/huggingface.mrs\`,
        path: './ruleset/huggingface.mrs',
        'path-in-bundle': 'geo/geosite/huggingface.mrs',
      },
`;

// 从 hosts 文件取出被屏蔽的域名（跳过注释掉的行），去重；格式不对就报错
export function parseHosts(...texts) {
  const domains = new Set();
  for (const text of texts) {
    for (const line of text.split('\n')) {
      const [ip, domain] = line.replace(/#.*/, '').trim().split(/\s+/);
      if (!domain) continue;
      if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain)) throw new Error(`hosts 里的「${ip} ${domain}」不是域名`);
      domains.add(domain.toLowerCase());
    }
  }
  if (domains.size === 0) throw new Error('hosts 里没有域名，上游清单可能改版了');
  return [...domains];
}

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
 * - 「AI」组默认选「台湾」
 * - 「台湾」地区组与「台湾-自动选择」用 Claude 的测速网址
 * - 「AdBlock」组加上 LoopDns/Fuck-you-MIUI 的 hosts 屏蔽清单（小米系统跟踪器、广告与内置 SDK）
 * - 新增「IPv6」节点组（名称标有 IPv6 / v6，或 server 为 IPv6 地址的节点），并加进「默认代理」
 * - 日志级别改为 warning，不再逐条记录连接；本机 xray / sing-box 进程直连，不经节点再代理一次
 * - 地区组默认选「<地区>-自动选择」，「默认代理」默认选全局「自动选择」
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
  block = addMiuiBlocklist(block);
  block = replaceOnce(block, "rules: ['RULE-SET,ai,AI'],", "rules: ['RULE-SET,huggingface,默认代理', 'RULE-SET,ai,AI'],", 'AI 规则');
  block = replaceOnce(
    block,
    `    name: 'AI',\n    testUrl: '${TEST_URLS.AI}',\n    baseOption: selectBaseOption,\n    defaultSelected: '美国',\n`,
    `    name: 'AI',\n    testUrl: '${TEST_URLS.AI}',\n    baseOption: selectBaseOption,\n    defaultSelected: '台湾',\n`,
    'AI 默认选择',
  );
  s = s.slice(0, start) + block + s.slice(end);
  s = setBaseTestOption(s);
  s = addRegionTestUrls(s);
  s = addIpv6Group(s);
  s = reduceMemory(s);
  s = defaultToAuto(s);

  return replaceOnce(
    s,
    '      icon: svc.icon,\n      proxies: groupProxies,\n',
    '      icon: svc.icon,\n      proxies: groupProxies,\n      // 分流组用各自服务的测速网址\n      ...(svc.testUrl && { url: svc.testUrl }),\n',
    '分流组生成代码',
  );
}

// 「AdBlock」组加上 Fuck-you-MIUI 的 mrs 规则集
export function addMiuiBlocklist(source) {
  const provider = `      // LoopDns/Fuck-you-MIUI 的 hosts 屏蔽清单（小米系统跟踪器、广告与内置 SDK），由本仓库转成 mrs
      'fuck-you-miui': {
        ...ruleProviderCommonDomain,
        url: '${MIUI_RULESET_URL}',
        path: './ruleset/fuck-you-miui.mrs',
      },
`;
  let s = replaceOnce(source, "      'category-ads': {\n", `${provider}      'category-ads': {\n`, 'AdBlock 规则集');
  return replaceOnce(
    s,
    "rules: ['RULE-SET,category-ads,AdBlock'],",
    "rules: ['RULE-SET,category-ads,AdBlock', 'RULE-SET,fuck-you-miui,AdBlock'],",
    'AdBlock 规则',
  );
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

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`抓取 ${url} 失败：HTTP ${res.status}`);
  return res.text();
}

// 清单写成 .txt（一行一个域名，方便看差异），有变化才用 mihomo 转成 .mrs
async function syncMiuiRuleset() {
  const domains = parseHosts(...(await Promise.all(MIUI_HOSTS_FILES.map((f) => fetchText(MIUI_HOSTS_UPSTREAM + f)))));
  const txt = new URL(`../${MIUI_RULESET}.txt`, import.meta.url);
  const text = domains.join('\n') + '\n';
  if ((await readFile(txt, 'utf8').catch(() => '')) !== text) {
    await writeFile(txt, text);
    const mihomo = process.env.MIHOMO || 'mihomo';
    try {
      execFileSync(mihomo, ['convert-ruleset', 'domain', 'text', txt.pathname, txt.pathname.replace(/\.txt$/, '.mrs')], {
        stdio: 'inherit',
      });
    } catch (err) {
      throw new Error(`用 ${mihomo} 转换 mrs 失败（需要安装 mihomo，或用 MIHOMO 环境变量指定路径）：${err.message}`);
    }
  }
  console.log(`Fuck-you-MIUI：${domains.length} 个域名 → ${MIUI_RULESET}.mrs`);
}

async function main() {
  await syncMiuiRuleset();
  for (const { from, to } of TARGETS) {
    const source = await fetchText(UPSTREAM + from);
    await writeFile(new URL(`../${to}`, import.meta.url), patchScript(source, from));
    console.log(`${from} → ${to}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
