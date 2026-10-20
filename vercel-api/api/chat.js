import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';

export const config = { runtime: 'edge' };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-cache, no-transform',
};

const MODEL = 'gpt-4o-mini';

// Keep the existing spend-token variable as a compatible trial fallback.
function getTokens() {
  const paid = process.env.LIGHTNINGPROX_PAID_TOKEN?.trim();
  const trial = process.env.LIGHTNINGPROX_TRIAL_TOKEN?.trim()
    || process.env.LIGHTNINGPROX_SPEND_TOKEN?.trim();
  return [...new Set([paid, trial].filter(Boolean))];
}

// Retry authentication/payment failures before any response stream is returned.
// Never retry a successful response or switch tokens during an active stream.
async function fetchWithTokenFallback(url, options = {}) {
  const tokens = getTokens();
  if (!tokens.length) throw new Error('LightningProx is not configured.');

  for (let index = 0; index < tokens.length; index += 1) {
    const headers = new Headers(options.headers);
    headers.delete('X-Spend-Token');
    headers.set('Authorization', `Bearer ${tokens[index]}`);
    const response = await fetch(url, { ...options, headers });
    const canFallback = [401, 402].includes(response.status)
      && index < tokens.length - 1;
    if (!canFallback) return response;
    await response.body?.cancel();
    console.info('Velopipe: primary token unavailable; trying fallback.', {
      status: response.status,
    });
  }
}

const lightningprox = createOpenAI({
  apiKey: 'server-side-token-routing',
  baseURL: 'https://lightningprox.com/v1',
  fetch: fetchWithTokenFallback,
});

const systemPrompt = `You are the Velopipe AI Assistant. Maintain a professional, clear, and modern tone.

Capabilities & Information Map:
1. Jump to Sections:
   - Electronics Line Cards (#electronics-section)
   - Automotive Innovations (#automotive-section)
   - Aviation Research (#aviation-section)
   - Industrial Software / AI (#infrastructure-section)
   - Green Hydrogen Data (#hydrogen-section)

2. Downloads & Resources:
   - Strategy Map (PDF) [strategymap.pdf]
   - Model Canvas (PDF) [modelcanvas.pdf]
   - AI Blog (PDF) [hbsai.pdf]

3. External Integrations:
   - OpenAI, Manus AI, and Zoho.

4. Enterprise Support:
   - Direct solutions via enterprise1@vishnucr9.org

Instructions:
- When asked about resources, downloads, sections, or external links, provide direct and polished answers.
- Explain clearly that users can pick from the action tray or type Y for quick file access.
- Keep output concise and well-formatted using bold tags where helpful.`;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await req.json();
    const messages = Array.isArray(body.messages) ? body.messages : [];

    const safeMessages = messages
      .filter((msg) => msg && ['user', 'assistant'].includes(msg.role))
      .slice(-12)
      .map(({ role, content }) => ({
        role,
        content: typeof content === 'string' ? content.slice(0, 2000) : '',
      }))
      .filter((msg) => msg.content);

    if (!safeMessages.length) return json({ error: 'A message is required.' }, 400);
    if (!getTokens().length) {
      return json({ error: 'The assistant is not configured.' }, 503);
    }

const result = streamText({
  model: lightningprox.chat(MODEL),
  system: systemPrompt,
  messages: safeMessages,
  maxTokens: 300,
  temperature: 0.3,
  maxRetries: 0, // Do not automatically repeat potentially billable requests.

  onFinish({ response, usage }) {
    console.info('Velopipe inference:', {
      requestedModel: MODEL,
      reportedModel: response.modelId,
      usage,
    });
  },
});

    return result.toTextStreamResponse({
      headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } catch (error) {
    console.error('Velopipe chat error:', error);
    return json({ error: 'The assistant is temporarily unavailable.' }, 500);
  }
}