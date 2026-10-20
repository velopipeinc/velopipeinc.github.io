export const config = { runtime: 'edge' };

const TARGET = 'harriedfreeze80@walletofsatoshi.com';
// CHANGE THESE THREE LINES:
const AMOUNT = 18;                             // Leaves 3 sats for fees (21 total)
const MAX_FEE = 2;                             // Gives the network up to 2 sats to route successfully
const IDEMPOTENCY_KEY = 'velopipe-wos-sweep-18-v2';

export default async function handler(req) {
  const reply = (data, status = 200) =>
    Response.json(data, {
      status,
      headers: { 'Cache-Control': 'no-store' },
    });

  if (req.method !== 'POST') {
    return reply({ error: 'Method not allowed' }, 405);
  }

  const secret = process.env.WALLET_CHECK_TOKEN;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return reply({ error: 'Unauthorized' }, 401);
  }

  if (!process.env.LN_API_KEY || !process.env.LN_WALLET_ID) {
    return reply({ error: 'LNbot configuration missing' }, 503);
  }

  const body = await req.json().catch(() => null);
  if (body?.confirm !== TARGET) {
    return reply({ error: 'Recipient confirmation required' }, 400);
  }

  const base =
    'https://api.ln.bot/v1/wallets/' +
    encodeURIComponent(process.env.LN_WALLET_ID);

  async function call(path, payload) {
    const response = await fetch(base + path, {
      method: payload ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${process.env.LN_API_KEY}`,
        'Content-Type': 'application/json',
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      throw new Error(`LNbot returned HTTP ${response.status}`);
    }

    return response.json();
  }

  let paymentSubmitted = false;

  try {
    const target = await call(
      `/payments/resolve?target=${encodeURIComponent(TARGET)}`
    );

    if (
      typeof target.min !== 'number' ||
      typeof target.max !== 'number' ||
      AMOUNT < target.min ||
      AMOUNT > target.max
    ) {
      return reply({
        error: 'Recipient does not accept this amount',
        minimum: target.min,
        maximum: target.max,
      }, 400);
    }

    const wallet = await call('');

    // Reserve 1 sat for the previously observed service fee as well.
    // This is a balance check, not a service-fee quote.
    if (wallet.available < AMOUNT + MAX_FEE + 1) {
      return reply({ error: 'Insufficient available balance' }, 400);
    }

    paymentSubmitted = true;

    const payment = await call('/payments', {
      target: TARGET,
      amount: AMOUNT,
      maxFee: MAX_FEE,
      idempotencyKey: IDEMPOTENCY_KEY,
      reference: 'Transfer to my Wallet of Satoshi',
    });

    return reply({
      number: payment.number,
      status: payment.status,
      amount: payment.amount,
      maxFee: payment.maxFee,
      actualFee: payment.actualFee,
      serviceFee: payment.serviceFee,
      failureReason: payment.failureReason,
    });
  } catch (error) {
    return reply({
      error: error.message,
      paymentMayHaveBeenSubmitted: paymentSubmitted,
      next: paymentSubmitted
        ? 'Check wallet payment history before taking further action.'
        : 'No payment was submitted by this request.',
    }, 502);
  }
}