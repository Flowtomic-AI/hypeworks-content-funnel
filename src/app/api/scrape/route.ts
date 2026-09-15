import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 60

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

// ─── Shared result type ──────────────────────────────────────────────────────

interface ScrapeResult {
  markdown: string | null
  imageUrls: string[]
}

// ─── Image extraction helper (shared by both scrapers) ──────────────────────

function extractProductImages(markdown: string): string[] {
  // Amazon CDN patterns: m.media-amazon.com and images-na.ssl-images-amazon.com
  const imagePattern =
    /https:\/\/(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com)\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png)/g
  const rawMatches = markdown.match(imagePattern) ?? []

  // Dedupe and prefer high-res variants, exclude sprites/thumbnails
  const seen = new Set<string>()
  const imageUrls: string[] = []

  for (const raw of rawMatches) {
    // Normalize size suffix → SL1500 for consistent high-res
    const normalized = raw.replace(/\._[A-Z0-9_,]+_\./g, '._AC_SL1500_.')
    if (!seen.has(normalized) && !raw.includes('sprite') && !raw.includes('trans-pixel')) {
      seen.add(normalized)
      imageUrls.push(normalized)
      if (imageUrls.length >= 7) break
    }
  }

  return imageUrls
}

// ─── Cloudflare Browser Rendering (primary) ──────────────────────────────────
//
// Uses real headless Chrome via Cloudflare's REST API.
// Env: CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (Browser Rendering - Edit)

async function scrapeWithCloudflare(url: string): Promise<ScrapeResult | null> {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) return null

  try {
    const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/browser-rendering/markdown`

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      },
      body: JSON.stringify({
        url,
        // Wait for most network activity to settle — catches JS-rendered content
        gotoOptions: { waitUntil: 'networkidle2' },
        // Skip heavy assets we don't need — just want text/markdown
        rejectRequestPattern: [
          '\\.woff2?$',
          '\\.ttf$',
          '\\.eot$',
          'google-analytics\\.com',
          'doubleclick\\.net',
          'googlesyndication\\.com',
        ],
      }),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.warn('[scrape] Cloudflare Browser Rendering error:', res.status, errText.substring(0, 200))
      return null
    }

    const json = await res.json()
    const markdown: string = json.result ?? ''
    if (!markdown) return null

    return { markdown, imageUrls: extractProductImages(markdown) }
  } catch (err) {
    console.warn('[scrape] Cloudflare scrape failed:', err)
    return null
  }
}

// ─── Firecrawl (secondary fallback) ──────────────────────────────────────────

async function scrapeWithFirecrawl(url: string): Promise<ScrapeResult | null> {
  if (!FIRECRAWL_API_KEY) return null

  try {
    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true,
        timeout: 30000,
      }),
    })

    if (!res.ok) return null

    const json = await res.json()
    const markdown: string = json.data?.markdown ?? ''

    return { markdown: markdown || null, imageUrls: extractProductImages(markdown) }
  } catch {
    return null
  }
}

// ─── Scraper driver: Cloudflare → Firecrawl → basic fetch ───────────────────

async function fetchPageContent(url: string): Promise<ScrapeResult> {
  // 1. Cloudflare Browser Rendering (real headless Chrome, handles JS)
  const cf = await scrapeWithCloudflare(url)
  if (cf?.markdown) return cf

  // 2. Firecrawl (managed scraping service)
  const fc = await scrapeWithFirecrawl(url)
  if (fc?.markdown) return fc

  // 3. Basic fetch (raw HTML, no JS execution)
  const rawHtml = await scrapeWithFetch(url)
  return { markdown: rawHtml, imageUrls: [] }
}

// ─── Basic fetch fallback (raw HTML) ────────────────────────────────────────

async function scrapeWithFetch(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    })

    if (!res.ok) return null
    return res.text()
  } catch {
    return null
  }
}

// ─── Claude: extract structured product data from page content ──────────────

type ExtractedProduct = {
  product_name: string
  brand_name: string
  description: string
  key_features: string[]
  target_audience: string
  category: string
  display_title: string
  tagline: string
  brand_colors: string[]
}

async function extractWithClaude(
  content: string,
  sourceUrl: string
): Promise<ExtractedProduct | null> {
  if (!ANTHROPIC_API_KEY) return null

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

  const truncated = content.substring(0, 15000)

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `You are a product data extraction and branding assistant. Analyze the following webpage content from ${sourceUrl} and extract structured product information.

Return ONLY valid JSON with these fields (no markdown, no explanation):
{
  "product_name": "full product name without store/site name",
  "brand_name": "brand or manufacturer name",
  "description": "2-3 sentence product description highlighting key selling points",
  "key_features": ["feature 1", "feature 2", ...up to 8 concise features, max 60 chars each],
  "target_audience": "who this product is for (e.g. 'fitness enthusiasts', 'home office workers')",
  "category": "product category (e.g. 'Electronics', 'Home & Kitchen')",
  "display_title": "short, punchy product title for marketing (max 5-7 words, e.g. 'Premium Beef Tallow Face Cream')",
  "tagline": "one-line marketing tagline (e.g. 'Natural skincare, real results.')",
  "brand_colors": ["#hex1", "#hex2"] (infer 2-3 brand colors from the page — look for brand imagery, logos, accent colors. Use complementary, professional hex colors that match the brand aesthetic. If unsure, choose colors appropriate for the product category.)
}

IMPORTANT for display_title: This is NOT the full Amazon product name. Create a short, compelling title suitable for a marketing banner. Strip out specifications, sizes, and SEO keywords.

IMPORTANT for brand_colors: These will be used as accent colors in A+ content design. Pick colors that feel authentic to the brand. For natural/organic products use earth tones. For tech products use blues/grays. For luxury products use golds/blacks.

If a field cannot be determined, use an empty string or empty array.

PAGE CONTENT:
${truncated}`,
        },
      ],
    })

    const text =
      message.content[0].type === 'text' ? message.content[0].text : ''

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0])

    return {
      product_name: String(parsed.product_name || '').trim(),
      brand_name: String(parsed.brand_name || '').trim(),
      description: String(parsed.description || '').trim(),
      key_features: Array.isArray(parsed.key_features)
        ? parsed.key_features.map(String).filter(Boolean).slice(0, 8)
        : [],
      target_audience: String(parsed.target_audience || '').trim(),
      category: String(parsed.category || '').trim(),
      display_title: String(parsed.display_title || '').trim(),
      tagline: String(parsed.tagline || '').trim(),
      brand_colors: Array.isArray(parsed.brand_colors)
        ? parsed.brand_colors
            .map(String)
            .filter((c: string) => /^#[0-9a-fA-F]{6}$/.test(c))
            .slice(0, 3)
        : [],
    }
  } catch (err) {
    console.error('Claude extraction error:', err)
    return null
  }
}

// ─── Regex fallback for raw HTML ────────────────────────────────────────────

function extractText(html: string, pattern: RegExp): string | null {
  const match = html.match(pattern)
  return match ? match[1].replace(/<[^>]+>/g, '').trim() : null
}

function extractAll(html: string, pattern: RegExp): string[] {
  const results: string[] = []
  let match
  const regex = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'
  )
  while ((match = regex.exec(html)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, '').trim()
    if (text && text.length > 3) results.push(text)
  }
  return results
}

function extractWithRegex(html: string, url: string): ExtractedProduct {
  const isAmazon = url.includes('amazon.com') || url.includes('amazon.co')

  let productName: string | null = null
  let brandName: string | null = null
  let description: string | null = null
  let features: string[] = []
  let category: string | null = null

  if (isAmazon) {
    productName =
      extractText(html, /id="productTitle"[^>]*>([^<]+)/i) ??
      extractText(html, /<title[^>]*>([^<]+)/i)

    brandName =
      extractText(html, /id="bylineInfo"[^>]*>(?:.*?by\s+)?([^<]+)/i) ??
      extractText(html, /class="po-break-word"[^>]*>([^<]+)/i)

    const bulletHtml = html.match(
      /id="feature-bullets"[\s\S]*?<ul[\s\S]*?<\/ul>/i
    )
    if (bulletHtml) {
      features = extractAll(
        bulletHtml[0],
        /<span[^>]*class="a-list-item"[^>]*>([\s\S]*?)<\/span>/gi
      )
    }
    if (!features.length) {
      features = extractAll(
        html,
        /<li[^>]*><span[^>]*class="a-list-item"[^>]*>([\s\S]*?)<\/span>/gi
      )
    }

    const descBlock = html.match(/id="productDescription"[\s\S]*?<\/div>/i)
    if (descBlock) {
      description = descBlock[0]
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 500)
    }

    const breadcrumbs = extractAll(
      html,
      /class="a-link-normal a-color-tertiary"[^>]*>([\s\S]*?)<\/a>/gi
    )
    if (breadcrumbs.length) category = breadcrumbs[breadcrumbs.length - 1]
  }

  if (!productName) productName = extractText(html, /<title[^>]*>([^<]+)/i)
  if (!description) {
    description =
      extractText(
        html,
        /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i
      ) ??
      extractText(
        html,
        /<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i
      )
  }
  if (!brandName) {
    brandName = extractText(
      html,
      /<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i
    )
  }

  if (productName) {
    productName = productName
      .replace(/Amazon\.com\s*:\s*/i, '')
      .replace(/\s*[-|]\s*Amazon.*$/i, '')
      .trim()
  }

  features = features
    .map((f) => f.trim())
    .filter((f) => f.length > 5 && f.length < 300)
    .slice(0, 8)

  const shortTitle = productName
    ? productName.split(/[,.]/).shift()?.trim().substring(0, 50) ?? productName
    : ''

  return {
    product_name: productName ?? '',
    brand_name: brandName ?? '',
    description: description ?? '',
    key_features: features,
    target_audience: '',
    category: category ?? '',
    display_title: shortTitle,
    tagline: '',
    brand_colors: [],
  }
}

// ─── ASIN extraction ────────────────────────────────────────────────────────

function extractAsin(url: string): string | null {
  const match =
    url.match(/\/dp\/([A-Z0-9]{10})/) ??
    url.match(/\/product\/([A-Z0-9]{10})/) ??
    url.match(/[?&]asin=([A-Z0-9]{10})/)
  return match ? match[1] : null
}

// ─── Amazon review scraping ──────────────────────────────────────────────────

async function scrapeReviews(asin: string): Promise<string[]> {
  if (!ANTHROPIC_API_KEY) return []
  // Need at least one scraper available for reviews
  if (!CLOUDFLARE_ACCOUNT_ID && !CLOUDFLARE_API_TOKEN && !FIRECRAWL_API_KEY) return []

  try {
    const reviewUrl = `https://www.amazon.com/product-reviews/${asin}?sortBy=recent&pageNumber=1`
    const result = await fetchPageContent(reviewUrl)
    if (!result.markdown) return []

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [
        {
          role: 'user',
          content: `Extract the 5 most useful customer review snippets from this Amazon reviews page. Focus on reviews that describe specific benefits, pain points solved, or vivid use-case details. Keep each snippet to 1-2 sentences max.

Return ONLY a JSON array of strings, no other text:
["review snippet 1", "review snippet 2", ...]

REVIEWS PAGE:
${result.markdown.substring(0, 8000)}`,
        },
      ],
    })

    const text =
      message.content[0].type === 'text' ? message.content[0].text.trim() : ''
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []

    const parsed = JSON.parse(jsonMatch[0])
    return Array.isArray(parsed)
      ? parsed.map(String).filter(Boolean).slice(0, 5)
      : []
  } catch {
    return []
  }
}

// ─── Main handler ───────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const url: string | undefined = body.url

  if (!url) {
    return NextResponse.json({ error: 'URL is required' }, { status: 400 })
  }

  // Block SSRF: only allow public HTTP/HTTPS URLs
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
    }
    const hostname = parsed.hostname.toLowerCase()
    // Block localhost and private IP ranges (IPv4 + IPv6)
    const blocked =
      /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.0\.0\.0|::1|fc00:|fd)/.test(hostname) ||
      hostname === '169.254.169.254' // AWS/GCP metadata endpoint
    if (blocked) {
      return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
    }
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }

  try {
    let method: 'ai' | 'regex' = 'regex'

    // Step 1: fetch page content — Cloudflare → Firecrawl → basic fetch
    const scrapeResult = await fetchPageContent(url)
    const { markdown: content, imageUrls: productImages } = scrapeResult

    if (!content) {
      return NextResponse.json(
        { error: 'Could not fetch the page. Check the URL and try again.' },
        { status: 400 }
      )
    }

    // Step 2: extract structured data — Claude first, then regex
    let extracted = await extractWithClaude(content, url)

    if (extracted) {
      method = 'ai'
    } else {
      // Claude unavailable or failed — fall back to regex on raw HTML
      const rawHtml = content.startsWith('<') ? content : await scrapeWithFetch(url) ?? ''
      extracted = extractWithRegex(rawHtml, url)
    }

    // Step 3: scrape reviews in parallel (Amazon only, best-effort)
    const asin = extractAsin(url)
    const productReviews = asin ? await scrapeReviews(asin) : []

    return NextResponse.json({
      ...extracted,
      source_url: url,
      extraction_method: method,
      product_images: productImages,
      product_reviews: productReviews,
    })
  } catch (err) {
    console.error('Scrape error:', err)
    return NextResponse.json(
      { error: 'Failed to extract product data. Check the URL and try again.' },
      { status: 500 }
    )
  }
}
