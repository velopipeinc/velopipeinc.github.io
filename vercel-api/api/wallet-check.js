export const config = { runtime: 'edge' };

export default async function handler(req) {
  const reply = (data, status = 200) =>
    Response.json(data, {
      status,
      headers: { 'Cache-Control': 'no-store' },
    });

  if (req.method !== 'GET') {
    return reply({ error: 'Method not allowed' }, 405);
  }

  const secret = process.env.WALLET_CHECK_TOKEN;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return reply({ error: 'Unauthorized' }, 401);
  }

  if (!process.env.LN_API_KEY) {
    return reply({ error: 'LN_API_KEY is missing' }, 503);
  }

  async function read(path) {
    const response = await fetch(`https://api.ln.bot${path}`, {
      headers: {
        Authorization: `Bearer ${process.env.LN_API_KEY}`,
      },
      signal: AbortSignal.timeout(10000),
      redirect: 'manual',
    });

    if (!response.ok) {
      throw new Error(`LNbot returned HTTP ${response.status}`);
    }
    return response.json();
  }

  try {
    const wallets = await read('/v1/wallets');
    if (!Array.isArray(wallets)) {
      throw new Error('Unexpected wallet-list response');
    }

    const balances = await Promise.all(wallets.map(async ({ walletId }) => {
      const wallet = await read(
        `/v1/wallets/${encodeURIComponent(walletId)}`
      );
      return {
        walletId,
        name: wallet.name,
        balance: wallet.balance,
        onHold: wallet.onHold,
        available: wallet.available,
        payments: await read(
  `/v1/wallets/${encodeURIComponent(walletId)}/payments?limit=3`
).then(items => items.map(payment => ({
  number: payment.number,
  status: payment.status,
  amount: payment.amount,
  actualFee: payment.actualFee,
  serviceFee: payment.serviceFee,
  failureReason: payment.failureReason,
  createdAt: payment.createdAt,
}))),
      };
    }));

    return reply({ wallets: balances });
  } catch (error) {
    return reply({ error: error.message }, 502);
  }
}