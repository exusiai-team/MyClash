// 从 AIsouler/MyClash 抓精简版与全量版覆写脚本，套用本项目的改动后写进 public/：
//   public/script.js       ← Script/Script.js（精简版，管理页默认）
//   public/script-full.js  ← Script/mihomoScript.js（全量版）
// 上游改版导致找不到要改的位置时直接报错，不会写出半成品。用法：node scripts/sync-scripts.mjs
import { writeFile } from 'node:fs/promises';

const UPSTREAM = 'https://raw.githubusercontent.com/AIsouler/MyClash/main/Script/';
const TARGETS = [
  { from: 'Script.js', to: 'public/script.js' },
  { from: 'mihomoScript.js', to: 'public/script-full.js' },
];

// 分流组的测速网址，全部取自 Bettbox 的服务检测（lib/common/media_unlock_checker.dart）；
// Bettbox 没检测的服务不列在这里，维持上游的通用测速网址
export const TEST_URLS = {
  YouTube: 'https://www.youtube.com/premium',
  Google: 'https://www.google.com/generate_204',
  AI: 'https://api.anthropic.com/cdn-cgi/trace',
  GitHub: 'https://github.com/',
  Apple: 'https://gspe1-ssl.ls.apple.com/pep/gcc',
  Telegram: 'http://91.108.56.100/',
  Steam: 'https://store.steampowered.com/',
  TikTok: 'https://perfops1.byteperf.com/500b-bench.jpg',
  Twitter: 'https://x.com/cdn-cgi/trace',
  Netflix: 'https://www.netflix.com/title/81280792',
  Spotify: 'https://www.spotify.com/signup',
  Crypto: 'https://www.coinbase.com/cdn-cgi/trace',
  PayPal: 'https://www.paypal.com/',
  EHentai: 'https://e-hentai.org/cdn-cgi/trace',
};

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
 * - 分流策略组使用各自服务的测速网址（参考 Bettbox 的服务检测），不再全部共用 groupBaseOption.url
 * - HuggingFace 用 bett-rules 的 huggingface 规则集分出来，不走「AI」组，改走「默认代理」
 * - 「AI」组默认选「台湾」
 * - 新增「IPv6」节点组（名称标有 IPv6 / v6，或 server 为 IPv6 地址的节点），并加进「默认代理」
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
  block = replaceOnce(block, "rules: ['RULE-SET,ai,AI'],", "rules: ['RULE-SET,huggingface,默认代理', 'RULE-SET,ai,AI'],", 'AI 规则');
  block = replaceOnce(
    block,
    `    name: 'AI',\n    testUrl: '${TEST_URLS.AI}',\n    baseOption: selectBaseOption,\n    defaultSelected: '美国',\n`,
    `    name: 'AI',\n    testUrl: '${TEST_URLS.AI}',\n    baseOption: selectBaseOption,\n    defaultSelected: '台湾',\n`,
    'AI 默认选择',
  );
  s = s.slice(0, start) + block + s.slice(end);
  s = addIpv6Group(s);

  return replaceOnce(
    s,
    '      icon: svc.icon,\n      proxies: groupProxies,\n',
    '      icon: svc.icon,\n      proxies: groupProxies,\n      // 分流组用各自服务的测速网址\n      ...(svc.testUrl && { url: svc.testUrl }),\n',
    '分流组生成代码',
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
  if (ipv6Proxies.length > 0) {
    generatedRegionGroups.push(...createRegionGroup('IPv6', \`\${iconBaseUrl}Global.svg\`, ipv6Proxies));
  }

`;

export function addIpv6Group(source) {
  const anchor = "  if (otherProxies.length > 0) {\n    generatedRegionGroups.push(...createRegionGroup('其他节点'";
  return replaceOnce(source, anchor, IPV6_GROUP + anchor, '其他节点组生成代码');
}

async function main() {
  for (const { from, to } of TARGETS) {
    const res = await fetch(UPSTREAM + from);
    if (!res.ok) throw new Error(`抓取 ${from} 失败：HTTP ${res.status}`);
    await writeFile(new URL(`../${to}`, import.meta.url), patchScript(await res.text(), from));
    console.log(`${from} → ${to}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
