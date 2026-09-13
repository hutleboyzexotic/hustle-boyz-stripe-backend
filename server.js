import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

/* ============================================================
   STRIPE CLIENT
   ============================================================ */
if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error(
    'STRIPE_SECRET_KEY is not set. Add it in your Render service\'s Environment settings.'
  );
}

// Pin an API version so Stripe never silently changes response shapes under you.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-12-18.acacia',
  appInfo: {
    name: 'hustle-boyz-stripe',
    version: '1.0.0',
  },
});

const app = express();

app.use(cors({ origin: process.env.CLIENT_URL }));

/* ============================================================
   WEBHOOKS (the nervous system connecting everything below to
   your app/DB)

   Stripe calls this endpoint whenever something happens — a
   payment succeeds, a subscription renews or is cancelled, an
   invoice is paid, a Connect account finishes onboarding, etc.
   This is where you actually grant/revoke access to premium
   picks, not in the success_url redirect (a user can close the
   tab before the redirect fires; the webhook always fires).

   IMPORTANT: this route needs the *raw* request body to verify
   the signature, so it's mounted with express.raw() BEFORE the
   global express.json() below. Don't move that.
   ============================================================ */
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body, // raw Buffer
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      // TODO: mark this customer as subscribed / grant premium-picks access
      // in your database, using session.customer / session.customer_email.
      console.log('Checkout completed for', session.customer_email || session.customer);
      break;
    }
    case 'invoice.paid': {
      const invoice = event.data.object;
      // TODO: extend the subscriber's access period.
      console.log('Invoice paid for customer', invoice.customer);
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      // TODO: email the customer, mark their account as past-due.
      console.log('Invoice payment failed for customer', invoice.customer);
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      // TODO: sync plan/status (active, past_due, canceled) to your database.
      console.log(`Subscription ${subscription.id} status: ${subscription.status}`);
      break;
    }
    case 'account.updated': {
      const account = event.data.object;
      // Connect: a payee finished (or updated) onboarding.
      console.log(`Connect account ${account.id} payouts_enabled=${account.payouts_enabled}`);
      break;
    }
    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  // Always 200 quickly — do slow work (emails, etc.) asynchronously, not here.
  res.json({ received: true });
});

app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

/* ============================================================
   PAYMENTS + BILLING + TAX (Checkout)
   Creates a Stripe Checkout Session. Works for either a one-time
   purchase (mode: 'payment') or a recurring subscription
   (mode: 'subscription') — pass the Price ID for whichever tier
   the customer picked.

   automatic_tax is turned on here, which is the Tax product:
   Stripe calculates and collects the correct sales tax / VAT
   based on the customer's location and your tax registrations.
   ============================================================ */
app.post('/api/checkout/session', async (req, res) => {
  try {
    const { priceId, mode = 'subscription', customerEmail } = req.body;

    if (!priceId) {
      return res.status(400).json({ error: 'priceId is required' });
    }

    const session = await stripe.checkout.sessions.create({
      mode, // 'subscription' for recurring plans, 'payment' for one-time
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: customerEmail || undefined,
      automatic_tax: { enabled: true },
      // Stripe Tax needs a customer address to calculate tax correctly.
      billing_address_collection: 'required',
      allow_promotion_codes: true,
      success_url: `${process.env.CLIENT_URL}/subscribe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/subscribe/cancelled`,
    }, {
      // Idempotency: prevent duplicate sessions if the client double-submits.
      idempotencyKey: req.headers['idempotency-key'] || undefined,
    });

    res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('checkout.session.create failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Look up a completed session (e.g. to render a receipt / confirmation page). */
app.get('/api/checkout/session/:id', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.id, {
      expand: ['line_items', 'customer'],
    });
    res.json(session);
  } catch (err) {
    res.status(404).json({ error: 'Session not found' });
  }
});

/* ============================================================
   BILLING
   Sends an existing subscriber to Stripe's hosted Customer
   Portal, where they can update their card, change plans
   (weekly <-> monthly), view invoices, or cancel — without you
   building any of that UI yourself.
   ============================================================ */
app.post('/api/billing/portal', async (req, res) => {
  try {
    const { customerId } = req.body;
    if (!customerId) {
      return res.status(400).json({ error: 'customerId is required' });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.CLIENT_URL}/account`,
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    console.error('billingPortal.sessions.create failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Cancel a subscription (defaults to "at period end" so they keep access they paid for). */
app.post('/api/billing/subscriptions/:id/cancel', async (req, res) => {
  try {
    const { immediately = false } = req.body;
    const subscription = immediately
      ? await stripe.subscriptions.cancel(req.params.id)
      : await stripe.subscriptions.update(req.params.id, { cancel_at_period_end: true });

    res.json(subscription);
  } catch (err) {
    console.error('subscription cancel failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** List a customer's subscriptions (e.g. to show plan status in your account page). */
app.get('/api/billing/customers/:id/subscriptions', async (req, res) => {
  try {
    const subs = await stripe.subscriptions.list({ customer: req.params.id, status: 'all' });
    res.json(subs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   CONNECT
   Use this if Hustle Boyz pays money out to other parties — e.g.
   revenue share for contributing analysts/handicappers, or
   affiliate payouts. If every dollar just goes to Hustle Boyz
   itself, you likely don't need Connect at all — Payments +
   Billing above already cover that.

   This uses Stripe Express accounts: Stripe hosts the onboarding
   form and identity verification for you, and pays out directly
   to the recipient's bank account.
   ============================================================ */

/** Step 1: create a connected Express account for a payee (analyst/affiliate). */
app.post('/api/connect/accounts', async (req, res) => {
  try {
    const { email } = req.body;

    const account = await stripe.accounts.create({
      type: 'express',
      email,
      capabilities: {
        transfers: { requested: true },
        card_payments: { requested: true },
      },
    });

    res.json({ accountId: account.id });
  } catch (err) {
    console.error('accounts.create failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Step 2: generate the one-time onboarding link Stripe hosts for that account. */
app.post('/api/connect/accounts/:id/onboarding-link', async (req, res) => {
  try {
    const accountLink = await stripe.accountLinks.create({
      account: req.params.id,
      refresh_url: `${process.env.CLIENT_URL}/partner/onboarding/refresh`,
      return_url: `${process.env.CLIENT_URL}/partner/onboarding/complete`,
      type: 'account_onboarding',
    });

    res.json({ url: accountLink.url });
  } catch (err) {
    console.error('accountLinks.create failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Step 3: once onboarded, send them a share of revenue (e.g. after a payout run). */
app.post('/api/connect/transfers', async (req, res) => {
  try {
    const { accountId, amount, currency = 'usd', description } = req.body;
    if (!accountId || !amount) {
      return res.status(400).json({ error: 'accountId and amount (in cents) are required' });
    }

    const transfer = await stripe.transfers.create({
      amount,
      currency,
      destination: accountId,
      description,
    });

    res.json(transfer);
  } catch (err) {
    console.error('transfers.create failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Check whether an account has finished onboarding and can receive payouts. */
app.get('/api/connect/accounts/:id', async (req, res) => {
  try {
    const account = await stripe.accounts.retrieve(req.params.id);
    res.json({
      id: account.id,
      payouts_enabled: account.payouts_enabled,
      charges_enabled: account.charges_enabled,
      details_submitted: account.details_submitted,
    });
  } catch (err) {
    res.status(404).json({ error: 'Account not found' });
  }
});

/* ============================================================
   INVOICING
   For one-off, itemized bills you send manually — e.g. a custom
   enterprise/bulk-access deal, not the self-serve weekly/monthly
   subscription (that's handled by Checkout + Billing above).
   ============================================================ */
app.post('/api/invoices', async (req, res) => {
  try {
    const { customerId, items, daysUntilDue = 7, autoAdvance = true } = req.body;
    if (!customerId || !items?.length) {
      return res.status(400).json({ error: 'customerId and a non-empty items array are required' });
    }

    for (const item of items) {
      await stripe.invoiceItems.create({
        customer: customerId,
        amount: item.amountCents,
        currency: item.currency || 'usd',
        description: item.description,
      });
    }

    const invoice = await stripe.invoices.create({
      customer: customerId,
      collection_method: 'send_invoice',
      days_until_due: daysUntilDue,
      automatic_tax: { enabled: true },
      auto_advance: autoAdvance,
    });

    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    await stripe.invoices.sendInvoice(finalized.id);

    res.json(finalized);
  } catch (err) {
    console.error('invoice creation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/invoices/:id', async (req, res) => {
  try {
    const invoice = await stripe.invoices.retrieve(req.params.id);
    res.json(invoice);
  } catch (err) {
    res.status(404).json({ error: 'Invoice not found' });
  }
});

app.post('/api/invoices/:id/void', async (req, res) => {
  try {
    const invoice = await stripe.invoices.voidInvoice(req.params.id);
    res.json(invoice);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   TAX
   Most of Stripe Tax happens automatically once enabled (see
   automatic_tax: { enabled: true } above) — Stripe detects the
   customer's location and applies the right sales tax/VAT. You
   still need to tell Stripe *where* you're registered to collect
   tax (Stripe Dashboard -> Settings -> Tax). These routes just
   let you check/calculate that from the app.
   ============================================================ */
app.get('/api/tax/registrations', async (req, res) => {
  try {
    const registrations = await stripe.tax.registrations.list({ limit: 20 });
    res.json(registrations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Ad-hoc tax calculation for a cart total before checkout, if you build a custom UI. */
app.post('/api/tax/calculate', async (req, res) => {
  try {
    const { amountCents, currency = 'usd', customerAddress } = req.body;

    const calculation = await stripe.tax.calculations.create({
      currency,
      line_items: [{ amount: amountCents, reference: 'subscription' }],
      customer_details: {
        address: customerAddress,
        address_source: 'billing',
      },
    });

    res.json(calculation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = process.env.PORT || 4242;
app.listen(port, () => {
  console.log(`Hustle Boyz Stripe service listening on http://localhost:${port}`);
});