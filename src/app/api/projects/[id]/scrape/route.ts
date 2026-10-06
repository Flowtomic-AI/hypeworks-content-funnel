import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isSafeUrl, safeFetch } from '@/lib/isSafeUrl'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params
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

  if (!isSafeUrl(url)) {
    return NextResponse.json({ error: 'Invalid or disallowed URL' }, { status: 400 })
  }

  try {
    const response = await safeFetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    })

    if (!response.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch URL' },
        { status: 400 }
      )
    }

    const html = await response.text()

    const scrapedData: Record<string, unknown> = {
      source_url: url,
      raw_text: html.substring(0, 5000),
    }

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    if (titleMatch) scrapedData.title = titleMatch[1].trim()

    const descMatch = html.match(
      /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i
    )
    if (descMatch) scrapedData.description = descMatch[1].trim()

    await supabase
      .from('projects')
      .update({
        scraped_data: scrapedData,
        product_name:
          typeof scrapedData.title === 'string'
            ? scrapedData.title
            : undefined,
      })
      .eq('id', projectId)
      .eq('user_id', user.id)

    return NextResponse.json({ success: true, scrapedData })
  } catch (err) {
    console.error('Scrape error:', err)
    return NextResponse.json(
      { error: 'Failed to scrape URL' },
      { status: 500 }
    )
  }
}
