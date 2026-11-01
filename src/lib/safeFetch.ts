import { isSafeUrl } from './isSafeUrl'

/**
 * A fetch wrapper that validates every redirect hop with isSafeUrl.
 * Prevents SSRF via open-redirect chains (e.g. https://attacker.com → http://169.254.169.254).
 */
export async function safeFetch(
  url: string,
  init?: Omit<RequestInit, 'redirect'>,
  maxRedirects = 5
): Promise<Response> {
  if (!isSafeUrl(url)) throw new Error(`safeFetch: blocked disallowed URL: ${url}`)

  let currentUrl = url
  let remaining = maxRedirects

  while (remaining > 0) {
    const response = await fetch(currentUrl, { ...init, redirect: 'manual' })

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('safeFetch: redirect with no Location header')

      const nextUrl = new URL(location, currentUrl).href
      if (!isSafeUrl(nextUrl)) {
        throw new Error(`safeFetch: redirect to disallowed URL blocked: ${nextUrl}`)
      }

      currentUrl = nextUrl
      remaining--
      continue
    }

    return response
  }

  throw new Error('safeFetch: too many redirects')
}
