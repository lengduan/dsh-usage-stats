/**
 * 插件自检：在装载进 profile 之前验证两半都能被宿主正常加载。
 *
 * 覆盖三类曾经真实翻车的问题：
 *   1. host 半：ESM 能否 import、是否导出 inject / apply。
 *   2. client 半：factory 是否 return module.exports（漏掉会让 boot 收到 undefined，
 *      插件静默失效，而 dsh web 本身仍能正常启动）。
 *   3. /usage/api 的访问控制：非 loopback 来源必须被围栏拒绝，而远程访问下
 *      client 半要能改走 remote-web-ui 的 /remote 门控通道。
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

// ── host 半：/usage/api 的 loopback 围栏 ──────────────────────────────────
console.log('host 半 lib/loopback-fence.js')
const fence = await import(pathToFileURL(path.join(root, 'lib', 'loopback-fence.js')).href)
/** 造一个最小请求：socket 远端地址 + Host 头 + 可选浏览器同源标记。 */
const req = (remoteAddress, hostHeader, headers = {}) => Object.assign(
  { socket: remoteAddress === undefined ? {} : { remoteAddress } },
  { headers: hostHeader === undefined ? {} : Object.assign({ host: hostHeader }, headers) },
)
check('loopback socket + loopback Host 放行', fence.isLoopbackRequest(req('127.0.0.1', '127.0.0.1:3080')))
check('::1 与 localhost 放行', fence.isLoopbackRequest(req('::1', 'localhost:3080')))
check('IPv4-mapped loopback 放行', fence.isLoopbackRequest(req('::ffff:127.0.0.1', '127.0.0.1:3080')))
check('127/8 内其他地址也算 loopback', fence.isLoopbackRequest(req('127.5.5.5', '127.5.5.5:3080')))
check('门控通道重发后的形状放行（same-origin，无 Origin）',
  fence.isLoopbackRequest(req('127.0.0.1', '127.0.0.1:3080', { 'sec-fetch-site': 'same-origin' })))
check('同源 Origin 放行', fence.isLoopbackRequest(req('127.0.0.1', '127.0.0.1:3080', { origin: 'http://127.0.0.1:3080' })))
check('LAN socket 拒绝（socket 是权威依据）', !fence.isLoopbackRequest(req('192.168.1.20', '127.0.0.1:3080')))
check('loopback socket + LAN Host 拒绝', !fence.isLoopbackRequest(req('127.0.0.1', '192.168.1.5:3080')))
check('私网地址拒绝', !fence.isLoopbackRequest(req('10.0.0.7', '10.0.0.7:3080')))
check('缺 Host 头拒绝', !fence.isLoopbackRequest(req('127.0.0.1', undefined)))
check('缺 socket 拒绝', !fence.isLoopbackRequest({ headers: { host: '127.0.0.1:3080' } }))
check('cross-site 标记拒绝', !fence.isLoopbackRequest(req('127.0.0.1', '127.0.0.1:3080', { 'sec-fetch-site': 'cross-site' })))
check('外来 Origin 拒绝', !fence.isLoopbackRequest(req('127.0.0.1', '127.0.0.1:3080', { origin: 'http://evil.example' })))
check('形似 loopback 的域名拒绝', !fence.isLoopbackRequest(req('127.0.0.1', 'localhost.evil.example:3080')))

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

// ── client 半：远程访问的取数路径 ─────────────────────────────────────────
// 围栏会拒绝非 loopback 来源，此时 client 半应改走 remote-web-ui 的 /remote
// 门控通道。用假 fetch 把三条路径各走一遍，抓 fetch 收到的路径序列。
console.log('client 半：403 后改走 /remote 门控通道')

/** 假响应：client 半只用到 status 与 json()。 */
const respond = (status, body) => ({ status, json: () => Promise.resolve(body) })

/** 在独立沙箱装载 bundle，渲染一次面板，返回 fetch 收到的路径序列。 */
async function usagePaths(fetchImpl) {
  const seen = []
  let def = null
  const box = {
    window: { __ModuleLoader__: { load: (d) => { def = d } } },
    console,
    navigator: { language: 'zh-CN' },
    fetch: (url) => { seen.push(String(url)); return fetchImpl(String(url)) },
  }
  vm.createContext(box)
  vm.runInContext(code, box)
  // useEffect 立即执行、useState 用初值，才能在无 React 环境下跑一次真实取数。
  const fakeReact = {
    createElement: () => null,
    useState: (value) => [value, () => {}],
    useEffect: (fn) => { fn() },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  }
  const mod = def.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`未声明的外部模块：${name}`)
  })
  let Component = null
  mod.apply({
    get: (name) => (name === 'slots'
      ? { inject: (_slot, fn) => fn(), register: (_options, C) => { Component = C; return () => {} } }
      : undefined),
  })
  Component({})
  // api() 是 Promise 链，让微任务跑完再断言。
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  return seen
}

const localPaths = await usagePaths(() => Promise.resolve(respond(200, { ok: true, rows: [] })))
check('本机直连只打 /usage/api', localPaths.length === 1 && localPaths[0] === '/usage/api', JSON.stringify(localPaths))

const remotePaths = await usagePaths((url) => Promise.resolve(url === '/usage/api'
  ? respond(403, { ok: false, error: 'forbidden: loopback-only' })
  : respond(200, { ok: true, rows: [] })))
check('被围栏 403 后改打 /remote/usage/api',
  remotePaths.length === 2 && remotePaths[0] === '/usage/api' && remotePaths[1] === '/remote/usage/api',
  JSON.stringify(remotePaths))

const noGatePaths = await usagePaths((url) => Promise.resolve(url === '/usage/api'
  ? respond(403, { ok: false, error: 'forbidden: loopback-only' })
  : respond(404, { ok: false, error: { code: 'unpaired' } })))
check('门控通道不存在时只多一次探测（不重试风暴）',
  noGatePaths.length === 2 && noGatePaths[1] === '/remote/usage/api', JSON.stringify(noGatePaths))

console.log(failed === 0 ? '\n自检通过。' : `\n自检失败：${failed} 项。`)
process.exit(failed === 0 ? 0 : 1)
