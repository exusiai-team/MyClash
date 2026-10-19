// 上游 MyClash 覆写脚本；Worker 的 /script.js 会抓它并在后面追加 PATCH
export const UPSTREAM_SCRIPT_URL = 'https://raw.githubusercontent.com/AIsouler/MyClash/main/Script/Script.js';

// 包装上游 main()，只改它输出的 mihomo 配置，不依赖上游源码排版：
// 用 bett-rules 的 huggingface 规则集（hf.co、hf.space、huggingface.co…）把 HuggingFace 从「AI」组分出来，改走「默认代理」。
// 规则集与「ai」同一个来源（同 CDN、格式、更新间隔），只换文件名；AI 组没开或找不到「默认代理」时不做任何事。
const PATCH = `
// ---- MyClash 追加：HuggingFace 不走 AI 组 ----
if (typeof main === 'function') {
  const myclashUpstreamMain = main;
  main = function (config) {
    const out = myclashUpstreamMain(config);
    const rules = Array.isArray(out && out.rules) ? out.rules : [];
    const aiIndex = rules.findIndex((r) => /^RULE-SET,ai,/.test(r));
    const ai = out && out['rule-providers'] && out['rule-providers'].ai;
    const hasTarget = (out['proxy-groups'] || []).some((g) => g.name === '默认代理');
    if (aiIndex === -1 || !ai || !ai.url || !hasTarget) return out;
    const rename = (s) => s.replace(/[^/]+\\.mrs$/, 'huggingface.mrs');
    const provider = { ...ai, url: rename(ai.url), path: './ruleset/huggingface.mrs' };
    if (ai['path-in-bundle']) provider['path-in-bundle'] = rename(ai['path-in-bundle']);
    out['rule-providers'] = { ...out['rule-providers'], huggingface: provider };
    rules.splice(aiIndex, 0, 'RULE-SET,huggingface,默认代理');
    return out;
  };
}
`;

export function patchScript(source) {
  return source + PATCH;
}
