import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/admin'
import { generateBackground } from '@/lib/fal/generate'
import { generateOptimizedPrompt } from '@/lib/fal/prompt'
import { proxyImageToFalStorage } from '@/lib/fal/imageProxy'
import { renderTemplate } from '@/lib/templates'
import type { TemplateData } from '@/lib/templates'
import { SLOT_DEFINITIONS, type SlotId } from '@/lib/templates/types'
import type { ImageIntent } from '@/lib/templates/types'
import { IMAGE_FORMATS, type ImageFormatType } from '@/types'
import type { StrategyAnalysis, SlotStrategy } from '../analyze/route'

// ─── Slot request type ───────────────────────────────────────────────────────

interface SlotRequest {
  slotId: SlotId
  format: ImageFormatType
  intent: ImageIntent
  headline?: string
  subheadline?: string
  copyBrief?: string
}

// ─── Build slot requests from body ──────────────────────────────────────────

function buildSlotRequests(
  body: Record<string, unknown>,
  analysis: StrategyAnalysis | null
): SlotRequest[] {
  // New API: explicit slots array
  if (Array.isArray(body.slots) && body.slots.length > 0) {
    return body.slots as SlotRequest[]
  }

  // Slot IDs specified
  if (Array.isArray(body.slotIds) && body.slotIds.length > 0) {
    const slotIds = body.slotIds as SlotId[]
    return slotIds.flatMap((id) => {
      const def = SLOT_DEFINITIONS.find((s) => s.id === id)
      if (!def) return []
      const strategy = analysis?.slot_strategy?.find((s) => s.slot_id === id)
      return [{
        slotId: id,
        format: def.format,
        intent: def.intent,
        headline: strategy?.headline,
        subheadline: strategy?.subheadline,
        copyBrief: strategy?.copy_brief ?? def.defaultBrief,
      }]
    })
  }

  // Legacy: formats array — map to default slots
  if (Array.isArray(body.formats) && body.formats.length > 0) {
    const formats = body.formats as ImageFormatType[]
    return formats.map((format) => {
      const def = SLOT_DEFINITIONS.find((s) => s.format === format) ?? SLOT_DEFINITIONS[0]
      const strategy = analysis?.slot_strategy?.find((s) => s.slot_id === def.id)
      return {
        slotId: def.id,
        format,
        intent: def.intent,
        headline: strategy?.headline,
        subheadline: strategy?.subheadline,
        copyBrief: strategy?.copy_brief ?? def.defaultBrief,
      }
    })
  }

  // Default: generate all slots
  return SLOT_DEFINITIONS.map((def) => {
    const strategy = analysis?.slot_strategy?.find((s) => s.slot_id === def.id)
    return {
      slotId: def.id,
      format: def.format,
      intent: def.intent,
      headline: strategy?.headline,
      subheadline: strategy?.subheadline,
      copyBrief: strategy?.copy_brief ?? def.defaultBrief,
    }
  })
}

export const maxDuration = 300

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params
    const supabase = await createClient()

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json(
        { error: 'Server configuration error: missing SUPABASE_SERVICE_ROLE_KEY' },
        { status: 500 }
      )
    }

    if (!process.env.FAL_KEY) {
      return NextResponse.json(
        { error: 'Server configuration error: missing FAL_KEY' },
        { status: 500 }
      )
    }

    const admin = createServiceRoleClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Admin emails bypass all credit checks
    const adminEmails = (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
    const isAdmin = adminEmails.includes((user.email ?? '').toLowerCase())

    const { data: profile } = await supabase
      .from('profiles')
      .select('credits_remaining, subscription_tier')
      .eq('id', user.id)
      .single()

    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
    }

    const body = await request.json()

    const { data: project } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .eq('user_id', user.id)
      .single()

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const scraped = project.scraped_data as Record<string, unknown> | null
    const analysis = (scraped?.analysis as StrategyAnalysis | null) ?? null
    const productReviews = (scraped?.product_reviews as string[]) ?? []
    const productImages = (scraped?.product_images as string[]) ?? []
    const primaryProductImage = productImages[0] ?? undefined

    // Proxy all product images to fal.ai storage upfront (in-process cache makes repeated calls free).
    // We rotate images across slots so each gets a different product photo for visual variety.
    const proxiedProductImages: string[] = []
    for (const img of productImages.slice(0, 5)) {
      try {
        const proxied = await proxyImageToFalStorage(img)
        proxiedProductImages.push(proxied)
      } catch {
        // skip failed proxies
      }
    }
    const proxiedProductImageUrl = proxiedProductImages[0] ?? undefined

    const slots = buildSlotRequests(body, analysis)
    const slotCount = slots.length

    if (!isAdmin && profile.subscription_tier === 'free') {
      if (profile.credits_remaining < slotCount) {
        return NextResponse.json(
          { error: 'Insufficient credits. Upgrade your plan to continue.' },
          { status: 403 }
        )
      }
      // Atomically deduct credits before generation; the conditional eq() acts as an
      // optimistic lock so two concurrent requests cannot both pass the check above
      // and then each decrement from the same snapshot value.
      const { data: deducted } = await admin
        .from('profiles')
        .update({ credits_remaining: profile.credits_remaining - slotCount })
        .eq('id', user.id)
        .eq('credits_remaining', profile.credits_remaining)
        .select('id')

      if (!deducted?.length) {
        return NextResponse.json(
          { error: 'Insufficient credits. Upgrade your plan to continue.' },
          { status: 403 }
        )
      }
    }

    await supabase
      .from('projects')
      .update({ status: 'generating' })
      .eq('id', projectId)

    // ── Run all slots in parallel ───────────────────────────────────────────
    const settled = await Promise.allSettled(
      slots.map(async (slot, slotIndex) => {
        const spec = IMAGE_FORMATS[slot.format]
        if (!spec) throw new Error(`Unknown format: ${slot.format}`)

        // Rotate product images across slots: each slot gets a different photo for visual variety.
        // Falls back to primary image if we only have one.
        const rotatedProductImage =
          proxiedProductImages.length > 1
            ? proxiedProductImages[slotIndex % proxiedProductImages.length]
            : proxiedProductImageUrl

        // Each generation gets a unique random seed so regenerating the same slot produces
        // a different composition rather than the same image every time.
        const generationSeed = Math.floor(Math.random() * 2_147_483_647)

        // Pick review highlight for social_proof slots
        const reviewHighlight =
          slot.intent === 'social_proof' && productReviews.length > 0
            ? productReviews[0]
            : productReviews.length > 0
              ? productReviews[Math.floor(Math.random() * productReviews.length)]
              : undefined

        // Phase 1: Generate optimized prompt via Claude
        const prompt = await generateOptimizedPrompt({
          productName: project.product_name ?? project.name,
          brandName: project.brand_name ?? undefined,
          category: project.category ?? undefined,
          keyFeatures: project.key_features,
          targetAudience: project.target_audience ?? undefined,
          contentTone: project.content_tone,
          brandColors: project.brand_colors,
          description:
            (scraped?.description as string) ?? project.description ?? undefined,
          productReviews: productReviews.length > 0 ? productReviews : undefined,
          intent: slot.intent,
          copyBrief: slot.copyBrief,
          headline: slot.headline,
          format: slot.format,
          width: spec.width,
          height: spec.height,
        })

        // Phase 2: Generate background
        // generate.ts handles model routing: Kontext (product in scene), Ideogram (design),
        // or Ultra (cinematic text-to-image). The proxy fixes Amazon CDN 422 errors.
        let backgroundImageUrl: string | null = null
        let requestId = ''
        let modelUsed = 'none'

        if (prompt !== 'SKIP') {
          const bgResult = await generateBackground({
            prompt,
            width: spec.width,
            height: spec.height,
            format: slot.format,
            intent: slot.intent,
            brandColors: project.brand_colors,
            referenceImageUrl: rotatedProductImage,
            seed: generationSeed,
          })

          if (bgResult) {
            backgroundImageUrl = bgResult.imageUrl
            requestId = bgResult.requestId
            modelUsed = bgResult.model
          }
        }

        // Phase 3: Composite via Satori + resvg
        const templateData: TemplateData = {
          format: slot.format,
          intent: slot.intent,
          slotId: slot.slotId,
          headline: slot.headline,
          subheadline: slot.subheadline,
          productName: project.product_name ?? project.name,
          displayTitle: (scraped?.display_title as string) || undefined,
          tagline: (scraped?.tagline as string) || undefined,
          brandName: project.brand_name ?? undefined,
          keyFeatures: project.key_features ?? [],
          description: project.description ?? undefined,
          targetAudience: project.target_audience ?? undefined,
          contentTone: project.content_tone,
          brandColors: project.brand_colors ?? [],
          backgroundImageUrl,
          productImageUrl: proxiedProductImageUrl,  // product photo composited directly into layout
          reviewHighlight,
        }

        const finalPng = await renderTemplate(templateData)

        const storagePath = `${user.id}/${projectId}/generated/${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${slot.format}.png`

        const { error: uploadError } = await admin.storage
          .from('generated-images')
          .upload(storagePath, finalPng, { contentType: 'image/png' })

        if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`)

        const { data: { publicUrl } } = admin.storage
          .from('generated-images')
          .getPublicUrl(storagePath)

        // Store slot metadata in prompt_used as JSON
        const promptMeta = JSON.stringify({
          slot: slot.slotId,
          intent: slot.intent,
          headline: slot.headline ?? '',
          prompt,
        })

        const { error: insertError } = await admin
          .from('generated_images')
          .insert({
            project_id: projectId,
            user_id: user.id,
            storage_path: storagePath,
            public_url: publicUrl,
            format_type: slot.format,
            width: spec.width,
            height: spec.height,
            prompt_used: promptMeta,
            fal_request_id: requestId,
            status: 'complete',
          })

        if (insertError) throw new Error(`DB insert failed: ${insertError.message}`)

        return {
          slotId: slot.slotId,
          format: slot.format,
          status: 'complete' as const,
          imageUrl: publicUrl,
          model: modelUsed,
        }
      })
    )

    // Record failures and build results array
    const results = await Promise.all(
      settled.map(async (result, i) => {
        if (result.status === 'fulfilled') return result.value

        const slot = slots[i]
        const message =
          result.reason instanceof Error ? result.reason.message : 'Unknown generation error'

        console.error(`Generation failed for slot ${slot.slotId}:`, message)

        const spec = IMAGE_FORMATS[slot.format]
        await admin.from('generated_images').insert({
          project_id: projectId,
          user_id: user.id,
          storage_path: '',
          format_type: slot.format,
          width: spec?.width ?? 0,
          height: spec?.height ?? 0,
          prompt_used: JSON.stringify({ slot: slot.slotId, error: message }),
          status: 'failed',
        })

        return { slotId: slot.slotId, format: slot.format, status: 'failed' as const, error: message }
      })
    )

    const successCount = results.filter((r) => r.status === 'complete').length
    const failedCount = slotCount - successCount

    // Credits were pre-deducted for all slotCount slots. Settle to only charge for
    // successfully generated images (profile.credits_remaining is the pre-request snapshot).
    if (!isAdmin && profile.subscription_tier === 'free' && failedCount > 0) {
      await admin
        .from('profiles')
        .update({ credits_remaining: profile.credits_remaining - successCount })
        .eq('id', user.id)
    }

    await supabase
      .from('projects')
      .update({ status: 'complete' })
      .eq('id', projectId)

    if (results.every((r) => r.status === 'failed')) {
      const firstError = results[0]?.error ?? 'All slots failed to generate'
      return NextResponse.json({ error: firstError, results }, { status: 500 })
    }

    return NextResponse.json({ results })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    console.error('Generate route error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
