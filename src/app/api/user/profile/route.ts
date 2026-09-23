import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isSafeUrl } from '@/lib/isSafeUrl'

export async function GET() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (error) {
    console.error('[GET /api/user/profile] Supabase error:', error.message)
    return NextResponse.json({ error: 'Failed to load profile' }, { status: 500 })
  }

  return NextResponse.json(data)
}

export async function PUT(request: Request) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()

  if (body.avatar_url !== undefined) {
    if (typeof body.avatar_url !== 'string' || !isSafeUrl(body.avatar_url)) {
      return NextResponse.json({ error: 'Invalid avatar_url' }, { status: 400 })
    }
  }

  const allowedFields = ['full_name', 'avatar_url']
  const updates: Record<string, unknown> = {}
  for (const field of allowedFields) {
    if (field in body) updates[field] = body[field]
  }

  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', user.id)
    .select()
    .single()

  if (error) {
    console.error('[PUT /api/user/profile] Supabase error:', error.message)
    return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 })
  }

  return NextResponse.json(data)
}
