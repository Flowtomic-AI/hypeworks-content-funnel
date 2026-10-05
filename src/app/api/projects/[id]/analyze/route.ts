import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import { SLOT_DEFINITIONS } from '@/lib/templates/types'
import { isSafeUrl } from '@/lib/isSafeUrl'

export const maxDuration = 120

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ConversionDriver {
  rank: number
  headline: string
  subheadline: string
  data_points: number
  customer_journey: 'Pre-Purchase' | 'Purchase' | 'Post-Purchase'
}

export interface ConversionBlocker {
  description: string
  impact: 'High' | 'Medium' | 'Low'
  fix: string
}

export interface SlotStrategy {
  slot_id: string
  headline: string
  subheadline: string
  copy_brief: string
}

export interface ImageDimensionScore {
  label: string   // e.g. "Design & Image Quality"
  score: number   // 1.0–5.0
}

export interface ImageScore {
  image_number: number
  type: string      // e.g. "Hero", "Lifestyle", "Infographic"
  score: number     // 1.0–5.0 overall
  dimensions: ImageDimensionScore[]
  what_we_see: string
  why_it_matters: string
  how_to_fix: string
}

export interface StrategyAnalysis {
  cro_potential: 'High' | 'Medium' | 'Low'
  image_performance_score: number  // 0–5
  reviews_analyzed: number
  conversion_drivers: ConversionDriver[]
  conversion_blockers: ConversionBlocker[]
  slot_strategy: SlotStrategy[]
  // Vision scoring fields
  overall_score?: number
  current_grade?: string
  estimated_conversion_lift?: string
  image_scores?: ImageScore[]
  missing_slots?: string[]
  top_recommendations?: string[]
  brand_voice_detected?: string
}

// ─── Phase 1: Review-based strategy analysis ─────────────────────────────────

async function analyzeStrategy(
  anthropic: Anthropic,
  project: Record<string, unknown>,
  reviews: string[]
): Promise<Partial<StrategyAnalysis>> {
  const scraped = project.scraped_data as Record<string, unknown> | null

  const reviewText = reviews.length
    ? reviews.map((r, i) => `${i + 1}. "${r}"`).join('\n')
    : 'No reviews available.'

  const slotList = SLOT_DEFINITIONS.map(
    (s) => `${s.id}: ${s.name} (${s.label}) — ${s.defaultBrief}`
  ).join('\n')

  const hasReviews = reviews.length > 0

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    messages: [
      {
        role: 'user',
        content: `You are an Amazon A+ content conversion strategist. Analyze this product and generate a complete content strategy.

PRODUCT:
- Name: ${project.product_name ?? project.name}
- Brand: ${project.brand_name ?? 'Unknown'}
- Category: ${project.category ?? 'Unknown'}
- Features: ${(project.key_features as string[] ?? []).slice(0, 6).join('; ')}
- Description: ${((scraped?.description as string) ?? (project.description as string) ?? '').substring(0, 300)}

CUSTOMER REVIEWS (${reviews.length} total):
${reviewText}

A+ CONTENT SLOTS TO FILL:
${slotList}

Return ONLY valid JSON (no markdown, no explanation):
{
  "cro_potential": "High|Medium|Low",
  "image_performance_score": <1.0-5.0 float, based on product complexity and review sentiment>,
  "reviews_analyzed": ${reviews.length},
  "conversion_drivers": [
    {
      "rank": 1,
      "headline": "<5-7 word benefit-focused headline, customer voice>",
      "subheadline": "<one supporting sentence, specific and credible>",
      "data_points": <integer, estimated importance 1-50 if no reviews or actual count if reviews exist>,
      "customer_journey": "Pre-Purchase"
    }
  ],
  "conversion_blockers": [
    {
      "description": "<what customers worry about that images don't address>",
      "impact": "High|Medium|Low",
      "fix": "<one-line visual fix recommendation>"
    }
  ],
  "slot_strategy": [
    {
      "slot_id": "HERO",
      "headline": "<punchy 4-7 word headline for this slot>",
      "subheadline": "<one compelling supporting line>",
      "copy_brief": "<specific visual direction for background image generation>"
    }
  ]
}

Rules:
- ALWAYS generate exactly 5-6 conversion_drivers. ${hasReviews ? 'Rank by review frequency. Use data_points = actual review count.' : 'No reviews available — infer drivers from the product name, features, description, category, and target audience. Use data_points = estimated importance (1–30 scale). Headlines must reflect what buyers in this category typically care about most.'}
- ALWAYS generate exactly 3-4 conversion_blockers. ${hasReviews ? 'Based on review friction.' : 'Based on common objections in this product category.'}
- Generate exactly 8 slot_strategy entries, one per slot (HERO, PT01–PT07)
- Headlines must be specific to THIS product, not generic
- For PT07 (Social Proof), ${hasReviews ? 'quote or paraphrase a real review' : 'craft a compelling customer-voice testimonial based on the product benefits'}
- copy_brief is for the AI background image generator — describe scene, lighting, environment
- cro_potential is High if product has clear, specific differentiators; Low if vague/commodity`,
      },
    ],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('No JSON in strategy response')

  return JSON.parse(jsonMatch[0])
}

// ─── Phase 2: Vision scoring of existing listing images ──────────────────────

async function scoreImages(
  anthropic: Anthropic,
  imageUrls: string[]
): Promise<Partial<StrategyAnalysis>> {
  const imageBlocks: Anthropic.ImageBlockParam[] = imageUrls.slice(0, 5).map((url) => ({
    type: 'image',
    source: { type: 'url', url },
  }))

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: [
          ...imageBlocks,
          {
            type: 'text',
            text: `You are an Amazon A+ content image quality auditor. Score these ${imageUrls.length} existing product listing images.

Return ONLY valid JSON:
{
  "overall_score": <0-100>,
  "current_grade": "<A|B|C|D|F>",
  "estimated_conversion_lift": "<X-Y%>",
  "image_scores": [
    {
      "image_number": 1,
      "type": "<Main Hero|Lifestyle|Infographic|Benefit|Comparison|Social Proof|How It Works>",
      "score": <1.0-5.0>,
      "dimensions": [
        { "label": "Design & Image Quality", "score": <1.0-5.0> },
        { "label": "Perceived Value", "score": <1.0-5.0> },
        { "label": "Message Strength", "score": <1.0-5.0> },
        { "label": "Message Clarity", "score": <1.0-5.0> }
      ],
      "what_we_see": "<1-2 sentence objective description of layout, composition, text>",
      "why_it_matters": "<1-2 sentence impact on buyer trust and conversion>",
      "how_to_fix": "<1-2 sentence specific, actionable improvement recommendation>"
    }
  ],
  "missing_slots": ["<content type that is missing>"],
  "top_recommendations": ["<rec 1>", "<rec 2>", "<rec 3>"],
  "brand_voice_detected": "<brief description>"
}

Scoring rubric (1.0-5.0):
- 5.0: Professional, conversion-optimized, Tier-1 brand quality
- 4.0: Good, clear message, minor polish needed
- 3.0: Adequate, but generic or lacks visual hierarchy
- 2.0: Weak, confusing layout or low visual quality
- 1.0: Very poor, fails to communicate product value`,
          },
        ],
      },
    ],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return {}

  return JSON.parse(jsonMatch[0])
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'Anthropic API not configured' }, { status: 500 })
  }

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
  const reviews = (scraped?.product_reviews as string[]) ?? []
  const imageUrls = ((scraped?.product_images as string[]) ?? []).filter(isSafeUrl)

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // Run strategy analysis always; run vision scoring in parallel if images exist
  const [strategyResult, visionResult] = await Promise.allSettled([
    analyzeStrategy(anthropic, project, reviews),
    imageUrls.length > 0 ? scoreImages(anthropic, imageUrls) : Promise.resolve({}),
  ])

  const strategy = strategyResult.status === 'fulfilled' ? strategyResult.value : {}
  const vision = visionResult.status === 'fulfilled' ? visionResult.value : {}

  const analysis: StrategyAnalysis = {
    cro_potential: (strategy.cro_potential as StrategyAnalysis['cro_potential']) ?? 'Medium',
    image_performance_score: strategy.image_performance_score ?? 3.0,
    reviews_analyzed: reviews.length,
    conversion_drivers: strategy.conversion_drivers ?? [],
    conversion_blockers: strategy.conversion_blockers ?? [],
    slot_strategy: strategy.slot_strategy ?? [],
    ...vision,
  }

  // Persist into scraped_data
  await supabase
    .from('projects')
    .update({
      scraped_data: {
        ...(scraped ?? {}),
        analysis,
        analyzed_at: new Date().toISOString(),
      },
    })
    .eq('id', projectId)
    .eq('user_id', user.id)

  return NextResponse.json(analysis)
}
