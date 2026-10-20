// 把 public/ 的两个覆写脚本包成 ES module，给 Worker 在服务端覆写订阅用：
//   public/script.js       → src/overrides/lite.js
//   public/script-full.js  → src/overrides/full.js
// 客户端执行的脚本不能有 export，Workers 又不能 eval，所以部署 / 测试前由这里生成（不进 git）。
// wrangler deploy / dev 会自动执行（wrangler.jsonc 的 build），npm test 前也会执行。
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const TARGETS = [
  { from: 'public/script.js', to: 'src/overrides/lite.js' },
  { from: 'public/script-full.js', to: 'src/overrides/full.js' },
];

const root = new URL('../', import.meta.url);
await mkdir(new URL('src/overrides/', root), { recursive: true });
for (const { from, to } of TARGETS) {
  const source = await readFile(new URL(from, root), 'utf8');
  if (!/^function main\(config\) \{$/m.test(source)) throw new Error(`${from} 找不到 main(config)`);
  await writeFile(new URL(to, root), `// 由 scripts/build-overrides.mjs 从 ${from} 生成，不要直接修改\n${source}\nexport default main;\n`);
}
