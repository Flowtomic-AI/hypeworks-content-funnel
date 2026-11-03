import { isSafeUrl } from './isSafeUrl'

const MAX_REDIRECTS = 5

/**
 * Drop-in replacement for fetch() on user-supplied URLs.
 *
 * Follows redirects manually so every hop is validated by isSafeUrl(),
 * preventing a redirect-chain SSRF bypass where isSafeUrl() clears the
 * initial URL but a server-side redirect points to an internal address.
 */
export async function safeFetch(
  url: string,
  options: RequestInit = {},
  hops = 0
): Promise<Response> {
  const res = await fetch(url, { ...options, redirect: 'manual' })

  if (res.status >= 300 && res.status < 400) {
    if (hops >= MAX_REDIRECTS) {
      throw new Error('Too many redirects')
    }
    const location = res.headers.get('location')
    if (!location) throw new Error('Redirect without Location header')

    const target = new URL(location, url).toString()
    if (!isSafeUrl(target)) {
      throw new Error(`Redirect target blocked by SSRF guard: ${new URL(target).hostname}`)
    }

    return safeFetch(target, options, hops + 1)
  }

  return res
}
