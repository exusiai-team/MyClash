// 上游 MyClash 覆写脚本；Worker 的 /script.js 会抓它并加上自己的规则
export const UPSTREAM_SCRIPT_URL = 'https://raw.githubusercontent.com/AIsouler/MyClash/main/Script/Script.js';

const ANCHOR = 'const prefixRules = [';

// 插在前置规则最前面，优先于 RULE-SET,ai,AI：HuggingFace 不走「AI」组，改走「默认代理」
export const EXTRA_RULES = ['DOMAIN-SUFFIX,huggingface.co,默认代理', 'DOMAIN-SUFFIX,hf.co,默认代理'];

/**
 * 在上游脚本的 prefixRules 开头插入 EXTRA_RULES；上游改版找不到位置时原样返回并加注释
 */
export function patchScript(source) {
  const i = source.indexOf(ANCHOR);
  if (i === -1) return `// MyClash：上游脚本结构已变，修补失败，以下为原始脚本\n${source}`;
  const end = i + ANCHOR.length;
  const inserted = EXTRA_RULES.map((r) => `\n  '${r}',`).join('');
  return `${source.slice(0, end)}\n  // MyClash：HuggingFace 不走 AI 组${inserted}${source.slice(end)}`;
}
