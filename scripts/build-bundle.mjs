/**
 * 把三个插件各打成一个自包含的 JS 文件，产物放进 bundle/dist/。
 *
 * 为什么要打包而不是 tsc 直接编译：
 *   源码里有 `@dsh-social/core` 这种工作区内部引用，靠 pnpm 的 node_modules 软链解析。
 *   装进 ~/.dsh/profiles/web 之后那套软链不存在，裸编译出来的 JS 会 import 失败。
 *   打包把四个包压成三个入口文件，内部引用全部内联，只留下外部依赖。
 *
 * external 的两个 @deepseek-ai 包**不能**打进来：
 *   它们必须和正在运行的那个 dsh 用同一份副本，否则 Service 类身份对不上。
 *   留成 external 之后，Node 会沿 profile 目录向上找到
 *   $DSH_HOME/profiles/node_modules —— 官方文档说的那个「每次启动都会修复」的
 *   安装回退目录，指向当前正在跑的那个 dsh 自己的包。
 */
import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'

const entries = {
  local: 'packages/local/src/index.ts',
  // cloud 也打进来，但 cordis.patch.yml 里默认不启用 —— 切换只需改配置
  cloud: 'packages/cloud/src/index.ts',
  web: 'packages/web/src/index.ts',
  curator: 'packages/curator/src/index.ts',
  commands: 'packages/commands/src/index.ts',
}

for (const [name, entry] of Object.entries(entries)) {
  await build({
    entryPoints: [entry],
    outfile: `bundle/dist/${name}.js`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // 保留可读性：这东西是给人看日志、贴堆栈用的，不是发给浏览器的
    minify: false,
    sourcemap: true,
    external: ['@deepseek-ai/*'],
    logLevel: 'info',
  })
}

/**
 * 浏览器半单独打。
 *
 * 产物必须包成宿主模块加载器认得的外壳：
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *
 * 这个形状是照着仓库里已构建的 client bundle 抄的
 * （deepseek-harness/packages/client/ui-jobs/lib/client.js），不是猜的。
 * react 和 @deepseek-ai/* 都留成 external，由宿主的 require 提供 ——
 * 打进来会得到第二份 React，hooks 立刻炸。
 */
const CLIENT_ID = 'dsh-social-plugin'

const client = await build({
  entryPoints: ['packages/web/src/client/index.ts'],
  outfile: 'bundle/dist/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  minify: false,
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/*'],
  write: false,
  logLevel: 'info',
})

const body = client.outputFiles[0].text
writeFileSync('bundle/dist/client.js', `window.__ModuleLoader__.load({
	id: ${JSON.stringify(CLIENT_ID)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
${body}
		return module.exports;
	}
});
`)
console.log('  bundle/dist/client.js  (已包上 __ModuleLoader__ 外壳)')
