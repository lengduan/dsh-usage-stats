/**
 * /usage/api 的请求级 loopback 围栏。
 *
 * DSH web 绑定到非 loopback（LAN）时，未列入宿主改写白名单、自身又无来源检查的
 * 路由会被同网段设备直接调用。`/usage/api` 正属于这类路由，所以在 handler 里自校验
 * 来源：socket 远端地址与 Host 头都必须是 loopback，并拒绝跨站标记。
 *
 * 语义与社区插件 @linxin666/dsh-session-archive 的 loopback 围栏一致：socket 地址
 * 是权威依据，永不采信 X-Forwarded-For。这样 remote-web-ui 的 `/remote` 门控通道
 * 在配对后以 127.0.0.1 重发（Host: 127.0.0.1:port、sec-fetch-site: same-origin、
 * 不带 Origin）时能正常通过，而 LAN 直连一律拒绝。
 */

/** IPv4 127/8 判定：四段十进制、首段为 127。 */
function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** socket 远端地址是否属于 loopback（127/8、::1、IPv4-mapped）。 */
export function isLoopbackAddress(address) {
  if (address === undefined || address === null) return false
  const normalized = String(address).toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/** 主机名是否指向 loopback（localhost、[::1]、127/8）。 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(String(hostname))
}

/**
 * 请求级判定：loopback socket + loopback Host，并校验浏览器同源标记。
 * socket 地址权威；X-Forwarded-For 一律不采信。
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request?.socket?.remoteAddress)) return false
  const host = request?.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try { hostUrl = new URL(`http://${host}`) } catch (e) { return false }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch (e) { return false }
}
