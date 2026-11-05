// 小火箭分流配置：按订阅改写 public/shadowrocket.conf（Worker 从 ASSETS 读出来），管理页导入的是这个版本。
// - 有 AI 链式代理的落地节点：加「AI落地」（名称以 🔗 开头的节点）与「AI链式代理」（中转，选项同 Google 组，含 DIRECT），
//   AI 组默认选「AI落地」。小火箭的配置文件没法替订阅节点设「代理通过」，订阅里的落地节点带着 dialer-proxy: AI链式代理，
//   小火箭不认的话要在 App 里给落地节点设一次「代理通过」（见 README）
// - 订阅里没有台湾节点：AI 组默认改选美国（同精简版）

export const LANDING_GROUP = 'AI落地';
export const RELAY_GROUP = 'AI链式代理';
// 同 shadowrocket.conf 与精简版的台湾地区正则
export const TAIWAN_RE = /🇹🇼|台湾|台北|高雄|(?<![A-Za-z])TWN?(?![A-Za-z])|taiwan/i;

// 「名称 = 类型,策略1,策略2,…,参数=值,…」：没有 = 的是策略；只用在 AI、Google 这类不带正则的组
function parseGroup(line) {
  const [name, value] = line.split(/ = (.*)/);
  const [type, ...items] = value.split(',');
  return { name, type, policies: items.filter((i) => !i.includes('=')), params: items.filter((i) => i.includes('=')) };
}
const formatGroup = ({ name, type, policies, params }) => `${name} = ${[type, ...policies, ...params].join(',')}`;

/**
 * @param {string} template public/shadowrocket.conf
 * @param {{ landing?: boolean, relay?: string, hasTaiwan?: boolean }} options
 */
export function rocketConf(template, { landing = false, relay = '香港', hasTaiwan = true } = {}) {
  const lines = template.split('\n');
  const find = (name) => lines.findIndex((l) => l.startsWith(`${name} = `));
  const aiIndex = find('AI');
  const googleIndex = find('Google');
  if (aiIndex === -1 || googleIndex === -1) throw new Error('shadowrocket.conf 找不到 AI 或 Google 组');

  const ai = parseGroup(lines[aiIndex]);
  if (!hasTaiwan && ai.policies.includes('美国')) ai.policies = ['美国', ...ai.policies.filter((p) => p !== '美国')];
  const added = [];
  if (landing) {
    const url = ai.params.filter((p) => p.startsWith('url='));
    const relayPolicies = parseGroup(lines[googleIndex]).policies;
    // select 组默认选第一项，所以把默认中转排到最前
    const ordered = relayPolicies.includes(relay) ? [relay, ...relayPolicies.filter((p) => p !== relay)] : relayPolicies;
    added.push(
      formatGroup({ name: LANDING_GROUP, type: 'select', policies: [], params: [...url, 'policy-regex-filter=^🔗'] }),
      formatGroup({ name: RELAY_GROUP, type: 'select', policies: ordered, params: url }),
    );
    ai.policies = [LANDING_GROUP, ...ai.policies];
  }
  lines.splice(aiIndex, 1, formatGroup(ai), ...added);
  return lines.join('\n');
}
