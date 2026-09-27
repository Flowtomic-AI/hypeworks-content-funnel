import { fal } from '@fal-ai/client'
import { isSafeUrl } from '@/lib/isSafeUrl'

// In-process URL cache: avoid re-uploading the same source image within a request batch.
// Capped at 200 entries to prevent unbounded growth in long-lived serverless instances.
const MAX_CACHE_SIZE = 200
const proxyCache = new Map<string, string>()

function cacheSet(key: string, value: string): void {
  if (proxyCache.size >= MAX_CACHE_SIZE) {
    // Evict oldest entry (Map iteration order is insertion order)
    const firstKey = proxyCache.keys().next().value
    if (firstKey !== undefined) proxyCache.delete(firstKey)
  }
  proxyCache.set(key, value)
}

/**
 * Proxies an external image URL through fal.ai storage.
 *
 * Why this is needed: models like flux-pro/kontext and flux/dev/image-to-image
 * fetch the reference image server-side. Amazon CDN URLs (m.media-amazon.com)
 * block non-browser user-agents, returning HTML error pages instead of the image —
 * which causes a 422 Unprocessable Entity from fal.ai.
 *
 * Fix: fetch the image ourselves (spoofing a browser UA), upload the buffer
 * to fal.ai storage, and pass back the stable fal.run/files/... URL.
 */
export async function proxyImageToFalStorage(sourceUrl: string): Promise<string> {
  // Already a fal.ai-hosted URL — pass through unchanged
  if (
    sourceUrl.startsWith('https://fal.run/') ||
    sourceUrl.startsWith('https://storage.fal.ai/') ||
    sourceUrl.startsWith('https://v3.fal.media/') ||
    sourceUrl.startsWith('https://fal.media/')
  ) {
    return sourceUrl
  }

  // SSRF guard: reject private/internal URLs even when they come from stored scraped_data
  if (!isSafeUrl(sourceUrl)) {
    throw new Error(`Disallowed image URL: ${sourceUrl}`)
  }

  // Return cached result to avoid duplicate uploads in the same generation batch
  const cached = proxyCache.get(sourceUrl)
  if (cached) return cached

  // Fetch image server-side, spoofing a browser user-agent to bypass Amazon CDN guards
  const response = await fetch(sourceUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
      Referer: 'https://www.amazon.com/',
    },
  })

  if (!response.ok) {
    throw new Error(
      `Failed to fetch product image from ${sourceUrl}: HTTP ${response.status}`
    )
  }

  const contentType = response.headers.get('content-type') ?? 'image/jpeg'

  // Validate that we actually received an image (not an HTML error page)
  if (!contentType.startsWith('image/')) {
    throw new Error(
      `Expected image content-type, got "${contentType}" from ${sourceUrl}`
    )
  }

  const buffer = await response.arrayBuffer()
  const blob = new Blob([buffer], { type: contentType })

  // Upload to fal.ai storage — returns a stable fal CDN URL
  const falUrl = await fal.storage.upload(blob)

  cacheSet(sourceUrl, falUrl)
  return falUrl
}
