/**
 * 插件自检：在装载进 profile 之前验证两半都能被宿主正常加载。
 *
 * 覆盖两类曾经真实翻车的问题：
 *   1. host 半：ESM 能否 import、是否导出 inject / apply。
 *   2. client 半：factory 是否 return module.exports（漏掉会让 boot 收到 undefined，
 *      插件静默失效，而 dsh web 本身仍能正常启动）。
 * 另外模拟一次 apply，确认 tab 真的注册到了 conversation.view。
 *
 * 用法：node scripts/verify.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '  [ok]' : '  [FAIL]'} ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) failed += 1
}

// ── host 半 ───────────────────────────────────────────────────────────────
console.log('host 半 lib/index.js')
const hostModule = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
// 官方 bundle 用 named export（export const inject / export function apply），
// default 对象形式也受支持；两种形状都接受，避免自检锁死其中一种。
const host = hostModule.default ?? hostModule
check('可 import 且导出插件', !!host && typeof host === 'object')
check('apply 是函数', typeof host?.apply === 'function')
check('inject 是数组', Array.isArray(host?.inject), JSON.stringify(host?.inject))

// ── client 半 ─────────────────────────────────────────────────────────────
console.log('client 半 lib/client.js')
const pkgName = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name
const code = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
let definition = null
const sandbox = {
  window: { __ModuleLoader__: { load: (def) => { definition = def } } },
  console,
}
vm.createContext(sandbox)
try {
  vm.runInContext(code, sandbox)
} catch (error) {
  check('脚本可执行', false, String(error?.message ?? error))
}
check('调用 __ModuleLoader__.load 注册了模块', !!definition)
check('bundle id 与包名一致（宿主按包名校验注册）', definition?.id === pkgName, `${String(definition?.id)} vs ${pkgName}`)

const React = {
  createElement: () => null,
  useState: () => [null, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}
const fakeRequire = (name) => {
  if (name === 'react') return React
  throw new Error(`未声明的外部模块：${name}`)
}

let exported = null
try {
  exported = definition.factory(fakeRequire)
} catch (error) {
  check('factory 可调用', false, String(error?.message ?? error))
}
// 这一条就是防"忘记 return module.exports"的回归
check('factory 返回模块对象（不是 undefined）', exported !== null && typeof exported === 'object')
check('导出 apply', typeof exported?.apply === 'function')
check('导出 inject', Array.isArray(exported?.inject))

// 模拟宿主 ctx，确认 apply 真的注册了 tab
let registered = null
const ctx = {
  get(name) {
    if (name === 'slots') {
      return {
        inject: (_slotName, fn) => fn(),
        register: (options, Component) => { registered = { options, Component }; return () => {} },
      }
    }
    return undefined
  },
}
try {
  exported?.apply?.(ctx)
} catch (error) {
  check('apply 可执行', false, String(error?.message ?? error))
}
check('注册到 conversation.view', registered?.options?.name === 'conversation.view')
check('tab id 正确', registered?.options?.id === 'usage-stats', String(registered?.options?.id))
check('tab label 可用', typeof registered?.options?.label === 'function' && !!registered.options.label())

console.log(failed === 0 ? '\n自检通过。' : `\n自检失败：${failed} 项。`)
process.exit(failed === 0 ? 0 : 1)
