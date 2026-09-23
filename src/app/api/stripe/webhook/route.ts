import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import Stripe from 'stripe'
import { getStripe } from '@/lib/stripe'
import { createServiceRoleClient } from '@/lib/supabase/admin'

export async function POST(request: Request) {
  const body = await request.text()
  const headersList = await headers()
  const sig = headersList.get('stripe-signature')

  if (!sig) {
    return NextResponse.json(
      { error: 'Missing stripe-signature header' },
      { status: 400 }
    )
  }

  const stripe = getStripe()

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err) {
    console.error('Webhook signature verification failed:', err)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const supabase = createServiceRoleClient()

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      const userId = session.metadata?.supabase_user_id
      if (!userId) break

      const subscriptionId =
        typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id

      if (subscriptionId) {
        const sub = await stripe.subscriptions.retrieve(subscriptionId)
        const priceId = sub.items.data[0]?.price?.id

        const tier =
          priceId === process.env.STRIPE_AGENCY_PRICE_ID
            ? 'agency'
            : priceId === process.env.STRIPE_PRO_PRICE_ID
              ? 'pro'
              : 'free'

        await supabase.from('subscriptions').upsert(
          {
            user_id: userId,
            stripe_subscription_id: subscriptionId,
            stripe_price_id: priceId,
            status: sub.status,
            current_period_start: new Date(
              sub.current_period_start * 1000
            ).toISOString(),
            current_period_end: new Date(
              sub.current_period_end * 1000
            ).toISOString(),
          },
          { onConflict: 'stripe_subscription_id' }
        )

        await supabase
          .from('profiles')
          .update({
            subscription_tier: tier,
            subscription_status: 'active',
          })
          .eq('id', userId)
      }
      break
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription
      const customerId =
        typeof sub.customer === 'string' ? sub.customer : sub.customer.id

      const { data: profiles } = await supabase
        .from('profiles')
        .select('id')
        .eq('stripe_customer_id', customerId)
        .limit(1)

      const userId = profiles?.[0]?.id
      if (!userId) break

      const priceId = sub.items.data[0]?.price?.id
      const tier =
        priceId === process.env.STRIPE_AGENCY_PRICE_ID
          ? 'agency'
          : priceId === process.env.STRIPE_PRO_PRICE_ID
            ? 'pro'
            : 'free'

      await supabase
        .from('subscriptions')
        .update({
          status: sub.status,
          stripe_price_id: priceId,
          current_period_start: new Date(
            sub.current_period_start * 1000
          ).toISOString(),
          current_period_end: new Date(
            sub.current_period_end * 1000
          ).toISOString(),
        })
        .eq('stripe_subscription_id', sub.id)

      await supabase
        .from('profiles')
        .update({
          subscription_tier: sub.status === 'active' ? tier : 'free',
          subscription_status: sub.status as 'active' | 'canceled' | 'past_due',
        })
        .eq('id', userId)
      break
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription
      const customerId =
        typeof sub.customer === 'string' ? sub.customer : sub.customer.id

      const { data: profiles } = await supabase
        .from('profiles')
        .select('id')
        .eq('stripe_customer_id', customerId)
        .limit(1)

      const userId = profiles?.[0]?.id
      if (!userId) break

      await supabase
        .from('subscriptions')
        .update({ status: 'canceled' })
        .eq('stripe_subscription_id', sub.id)

      await supabase
        .from('profiles')
        .update({
          subscription_tier: 'free',
          subscription_status: 'canceled',
        })
        .eq('id', userId)
      break
    }
  }

  return NextResponse.json({ received: true })
}
