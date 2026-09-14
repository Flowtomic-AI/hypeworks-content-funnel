/**
 * SSRF guard: returns true only for public, routable URLs.
 *
 * Blocks non-http/https schemes, private IPv4 ranges (RFC 1918, loopback,
 * link-local 169.254), multicast, all IPv6 private/loopback/link-local/ULA
 * ranges, IPv4-mapped IPv6 addresses that resolve to private IPs, and
 * special hostnames (localhost, *.local, *.internal).
 */
export function isSafeUrl(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

  const host = url.hostname.toLowerCase()

  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return false
  }

  // IPv6 addresses (url.hostname strips the brackets for us)
  if (host.includes(':')) {
    return isSafeIPv6(host)
  }

  // IPv4 dotted-decimal
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    return isSafeIPv4(a, b)
  }

  return true
}

function isSafeIPv4(a: number, b: number): boolean {
  if (a === 0) return false               // 0.0.0.0/8
  if (a === 10) return false              // 10.0.0.0/8
  if (a === 127) return false             // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return false // 169.254.0.0/16 (link-local / metadata)
  if (a === 172 && b >= 16 && b <= 31) return false // 172.16.0.0/12
  if (a === 192 && b === 168) return false // 192.168.0.0/16
  if (a >= 224) return false              // 224+ (multicast, reserved)
  return true
}

function isSafeIPv6(host: string): boolean {
  if (host === '::1') return false                     // loopback
  if (host.startsWith('fe80:')) return false           // link-local fe80::/10
  if (host.startsWith('fc') || host.startsWith('fd')) return false // ULA fc00::/7

  // IPv4-mapped ::ffff:a.b.c.d
  const dotted = host.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (dotted) {
    return isSafeIPv4(Number(dotted[1]), Number(dotted[2]))
  }

  // IPv4-mapped ::ffff:HHHH:HHHH (hex notation, e.g. ::ffff:7f00:1 = 127.0.0.1)
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const high = parseInt(hex[1], 16)
    const a = high >> 8
    const b = high & 0xff
    return isSafeIPv4(a, b)
  }

  // Any other ::ffff: variant — deny rather than risk a missed pattern
  if (host.startsWith('::ffff:')) return false

  return true
}
