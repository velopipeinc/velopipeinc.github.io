const INFERENCE_URL =
  'https://lightningprox.com/v1/chat/completions';

const MAX_INVOICE_SATS = 20;

async function request(url, options = {}) {
  return fetch(url, {
    ...options,
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
}

async function walletRequest(path, payload) {
  const walletId = process.env.LN_WALLET_ID;
  const response = await request(
    `https://api.ln.bot/v1/wallets/${encodeURIComponent(walletId)}${path}`,
    {
      method: payload ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${process.env.LN_API_KEY}`,
        'Content-Type': 'application/json',
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    }
  );

  if (!response.ok) {
    throw new Error(`LNbot returned HTTP ${response.status}`);
  }

  return response.json();
}

async function invoiceKey(invoice) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(invoice)
  );

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

// Returns null when it is safe to use trial credit instead.
// Once payment submission starts, uncertain errors stop the request.
export async function tryLnBotInference({
  model,
  system,
  messages,
}) {
  if (!process.env.LN_API_KEY || !process.env.LN_WALLET_ID) {
    throw new Error('LNbot configuration is missing.');
  }

  let wallet;

  try {
    wallet = await walletRequest('');
  } catch {
    console.info('Velopipe payment:', {
      source: 'trial',
      reason: 'Wallet balance unavailable; no payment attempted',
    });
    return null;
  }

  if (
    !Number.isSafeInteger(wallet.available) ||
    wallet.available < 5
  ) {
    return null;
  }

  // Reuse this exact string when redeeming the L402 credential.
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    max_tokens: 300,
    temperature: 0.3,
    stream: false,
  });

  let quote;
  let resolved;

  try {
    const challenge = await request(INFERENCE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (challenge.status !== 402) {
      console.info('Velopipe payment:', {
        source: 'trial',
        reason: 'No usable L402 challenge',
        upstreamStatus: challenge.status,
      });
      return null;
    }

    quote = await challenge.json();

    if (
      typeof quote.invoice !== 'string' ||
      !quote.invoice.startsWith('lnbc') ||
      typeof quote.macaroon !== 'string' ||
      !quote.macaroon
    ) {
      throw new Error('Invalid L402 challenge');
    }

    // Ask LNbot to inspect the actual invoice before payment.
    resolved = await walletRequest(
      `/payments/resolve?target=${encodeURIComponent(quote.invoice)}`
    );
  } catch {
    console.info('Velopipe payment:', {
      source: 'trial',
      reason: 'Quote validation failed; no payment attempted',
    });
    return null;
  }

  const amount = resolved.amount;

  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    amount > MAX_INVOICE_SATS ||
    amount > wallet.available ||
    (
      quote.amount_sats !== undefined &&
      quote.amount_sats !== amount
    )
  ) {
    console.info('Velopipe payment:', {
      source: 'trial',
      reason: 'Invoice outside budget or amount mismatch',
    });
    return null;
  }

  const idempotencyKey = await invoiceKey(quote.invoice);
  let payment;

  try {
    payment = await walletRequest('/payments', {
      target: quote.invoice,
      maxFee: 0,
      idempotencyKey,
      reference: 'Velopipe GPT-4o mini inference',
    });

    // Check pending payments without submitting another payment.
    for (
      let attempt = 0;
      attempt < 3 &&
      payment.status !== 'settled' &&
      payment.status !== 'failed' &&
      Number.isSafeInteger(payment.number);
      attempt++
    ) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      payment = await walletRequest(`/payments/${payment.number}`);
    }
  } catch {
    throw new Error(
      'Payment confirmation unavailable. Check LNbot before retrying.'
    );
  }

  if (payment.status === 'failed') {
    console.info('Velopipe payment:', {
      source: 'trial',
      reason: 'LNbot confirmed payment failure',
      paymentNumber: payment.number,
    });
    return null;
  }

  if (
    payment.status !== 'settled' ||
    !/^[a-f0-9]{64}$/i.test(payment.preimage || '')
  ) {
    throw new Error(
      'Payment is not confirmed. Check LNbot before retrying.'
    );
  }

  console.info('Velopipe payment:', {
    source: 'lnbot',
    paymentNumber: payment.number,
    amount: payment.amount,
    routingFee: payment.actualFee,
    serviceFee: payment.serviceFee,
  });

  // Payment has settled: do not silently spend trial credit on errors.
  try {
    const response = await request(INFERENCE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:
          `L402 ${quote.macaroon}:${payment.preimage}`,
      },
      body,
    });

    if (!response.ok) {
      throw new Error('Paid inference failed');
    }

    const result = await response.json();
    const text = result.choices?.[0]?.message?.content;

    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('Paid inference returned no text');
    }

    console.info('Velopipe inference:', {
      fundingSource: 'lnbot',
      requestedModel: model,
      reportedModel: result.model,
      usage: result.usage,
    });

    return text;
  } catch {
    throw new Error(
      'LNbot payment settled, but no answer was received. ' +
      'Check the payment log before retrying.'
    );
  }
}