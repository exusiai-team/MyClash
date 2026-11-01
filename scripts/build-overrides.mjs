// 准备两个覆写脚本，给 Worker 在服务端覆写订阅用：
//   1. 取 rules 分支的 script.js、script-full.js，放进 public/（不进 git；/script.js、/script-full.js 也由此提供）。
//      设了 GENERATED_DIR 就从该目录复制（同步流程测试刚生成的文件），否则从 GitHub 的 rules 分支下载；
//      下载失败时沿用 public/ 里已有的文件，没有就报错。
//   2. 包成 ES module：public/script.js → src/overrides/lite.js、public/script-full.js → src/overrides/full.js
// 客户端执行的脚本不能有 export，Workers 又不能 eval，所以部署 / 测试前由这里生成（不进 git）。
// wrangler deploy / dev 会自动执行（wrangler.jsonc 的 build），npm test 前也会执行。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);

const TARGETS = [
  { name: 'script.js', to: 'src/overrides/lite.js' },
  { name: 'script-full.js', to: 'src/overrides/full.js' },
];

async function repo() {
  if (process.env.GITHUB_REPO) return process.env.GITHUB_REPO;
  const config = await readFile(new URL('wrangler.jsonc', root), 'utf8');
  const found = config.match(/"GITHUB_REPO":\s*"([^"]+)"/);
  if (!found) throw new Error('wrangler.jsonc 里找不到 GITHUB_REPO');
  return found[1];
}

// 取最新的脚本；返回 null 表示拿不到（交给调用方决定要不要沿用已有的文件）
async function fetchGenerated(name) {
  if (process.env.GENERATED_DIR) return readFile(join(process.env.GENERATED_DIR, name), 'utf8');
  const url = `https://raw.githubusercontent.com/${await repo()}/rules/${name}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    console.warn(`下载 ${url} 失败：${err.message}`);
    return null;
  }
}

await mkdir(new URL('src/overrides/', root), { recursive: true });
for (const { name, to } of TARGETS) {
  const file = new URL(`public/${name}`, root);
  const latest = await fetchGenerated(name);
  const existing = await readFile(file, 'utf8').catch(() => null);
  if (latest === null && existing === null) throw new Error(`拿不到 ${name}：rules 分支还没有这个文件，且 public/ 里也没有`);
  if (latest === null) console.warn(`沿用 public/${name}`);
  const source = latest ?? existing;
  // 内容没变就不写，免得 wrangler dev 监看 public/ 时反复重新打包
  if (source !== existing) await writeFile(file, source);
  if (!/^function main\(config\) \{$/m.test(source)) throw new Error(`public/${name} 找不到 main(config)`);
  await writeFile(new URL(to, root), `// 由 scripts/build-overrides.mjs 从 public/${name} 生成，不要直接修改\n${source}\nexport default main;\n`);
}
