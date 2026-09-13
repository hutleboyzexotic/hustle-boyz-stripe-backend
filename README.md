# Hustle Boyz — Stripe Integration

A standalone, drop-in backend covering the five Stripe products you asked for: **Payments, Billing, Connect, Invoicing, Tax**. It's a small Express service you can run next to your existing site, or fold directly into it — each piece is one file in `src/routes/`.

## ⚠️ Read this before you launch

Stripe's restricted-business list prohibits **"sports forecasting or odds-making with a monetary or material prize"** under its Gambling category. Hustle Boyz sells paid subscriptions to sports picks with a tracked win %/ROI — that's close enough to this language that a Stripe account could be flagged, held, or closed during or after underwriting. This doesn't block building or testing the integration (below all runs in Stripe's test mode), but before you request a **live** Stripe account:

- Consider reframing the paid product around analysis/commentary/stats rather than "picks," and dropping or reframing the win%/ROI tracking (see full notes from your conversation with Claude).
- Expect Stripe's underwriting team to evaluate the actual business, not just the copy.
- This is not legal advice — if this is a meaningful revenue line for you, a quick read of Stripe's own restricted-business page (stripe.com/legal/restricted-businesses) or a conversation with a lawyer familiar with gambling-adjacent fintech is worth the hour.

## What's included

| Stripe product | File | What it does |
|---|---|---|
| Payments | `src/routes/checkout.js` | Creates Checkout Sessions for one-time or subscription purchases |
| Billing | `src/routes/billing.js` | Customer Portal (self-serve plan changes/cancellation), subscription management |
| Connect | `src/routes/connect.js` | Onboards payees (e.g. revenue-share for contributing analysts) and pays them out — skip this if every dollar stays with Hustle Boyz |
| Invoicing | `src/routes/invoicing.js` | One-off itemized invoices (e.g. a custom/bulk deal), separate from self-serve subscriptions |
| Tax | `src/routes/tax.js` + `automatic_tax` in checkout/invoicing | Automatic sales tax/VAT calculation and collection |
| (all of the above) | `src/routes/webhook.js` | The webhook is what actually grants/revokes access in your app — don't skip wiring this up |

## Setup

This sandbox can't reach `registry.npmjs.org` or `api.stripe.com` (its network is locked down), so the steps below need to run somewhere with normal internet access — your own machine, or your Render service.

```bash
npm install
cp .env.example .env   # your test keys are already filled in below
```

Your test keys (from this conversation) are already in `.env`:
- Publishable key: `pk_test_51UEHzv...` (safe to expose in frontend code)
- Secret key: `sk_test_51UEHzv...` (server-side only — never ship this to the browser or commit it to git; `.gitignore` already excludes `.env`)

1. **Create your products/prices** (placeholder pricing — edit the numbers in the script first):
   ```bash
   npm run setup:catalog
   ```
   Paste the printed `STRIPE_PRICE_WEEKLY` / `STRIPE_PRICE_MONTHLY` into `.env`.

2. **Forward webhooks locally** with the [Stripe CLI](https://docs.stripe.com/stripe-cli):
   ```bash
   stripe listen --forward-to localhost:4242/api/webhook
   ```
   Copy the `whsec_...` it prints into `STRIPE_WEBHOOK_SECRET` in `.env`.

3. **Run the server:**
   ```bash
   npm start
   ```

4. **Check tax registration status:**
   ```bash
   npm run setup:tax
   ```

## Wiring it into your frontend

From your site (wherever the "Subscribe" buttons are), call:

```js
const res = await fetch('https://your-api-host/api/checkout/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    priceId: 'price_...',        // STRIPE_PRICE_WEEKLY or STRIPE_PRICE_MONTHLY
    mode: 'subscription',
    customerEmail: user?.email,  // optional, pre-fills Checkout
  }),
});
const { url } = await res.json();
window.location.href = url;      // redirect to Stripe Checkout
```

After payment, Stripe redirects back to `CLIENT_URL/subscribe/success`, but the **source of truth is the webhook** (`checkout.session.completed`) — that's where you should actually flip the user to "premium" in your database, since a closed tab means the redirect never fires but the webhook always will.

## Testing without real money

Use Stripe's test cards in Checkout: `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP. Full list: https://docs.stripe.com/testing.

## Deploying alongside your Render site

- Add this as a second Render service (Web Service, Node), or merge these route files into your existing Express app if it already runs Node.
- Set the same env vars in Render's dashboard (Environment tab) instead of committing `.env`.
- Create a webhook endpoint in the [Stripe Dashboard](https://dashboard.stripe.com/test/webhooks) pointing at `https://<your-render-service>/api/webhook`, subscribed at minimum to: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`.
- Switch `sk_test_...` / `pk_test_...` to live keys only once you've actually been approved for a live Stripe account (see the warning at the top).

## If you already have Stripe code on the live site

Point Claude at the actual project folder or repo and it'll review what's there against this plan and adjust rather than duplicate it.
