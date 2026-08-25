import net from 'node:net';

export function isIpHost(host: string) {
  return net.isIP(host) !== 0;
}

/** RFC 6066：SNI 不能是 IP。传空字符串可关闭 SNI，避免 Node DEP0123。 */
export function tlsServerName(host: string) {
  return isIpHost(host) ? '' : host;
}
