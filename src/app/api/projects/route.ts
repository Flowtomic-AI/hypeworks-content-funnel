import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[GET /api/projects] Supabase error:', error.message)
    return NextResponse.json({ error: 'Failed to load projects' }, { status: 500 })
  }

  return NextResponse.json(data)
}

export async function POST(request: Request) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()

  const { data, error } = await supabase
    .from('projects')
    .insert({
      user_id: user.id,
      name: body.name,
      product_name: body.product_name,
      brand_name: body.brand_name,
      description: body.description,
      key_features: body.key_features ?? [],
      target_audience: body.target_audience,
      category: body.category,
      content_tone: body.content_tone ?? 'professional',
      brand_colors: body.brand_colors ?? [],
      source_urls: body.source_urls ?? [],
      scraped_data: body.scraped_data ?? null,
    })
    .select()
    .single()

  if (error) {
    console.error('[POST /api/projects] Supabase error:', error.message)
    return NextResponse.json({ error: 'Failed to create project' }, { status: 500 })
  }

  return NextResponse.json(data, { status: 201 })
}
