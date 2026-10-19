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

const lightningprox = createOpenAI({
  apiKey: process.env.LIGHTNINGPROX_SPEND_TOKEN,
  baseURL: 'https://lightningprox.com/v1',
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
    if (!process.env.LIGHTNINGPROX_SPEND_TOKEN) {
  return json({ error: 'The assistant is not configured.' }, 503);
}

// Under your try-catch block, make sure streamText uses these stable settings:
const result = streamText({
  model: lightningprox.chat(MODEL),
  system: systemPrompt,
  messages: safeMessages,
  maxTokens: 300,
  temperature: 0.3, // Hardened anchor for predictable routing outputs
});

    return result.toTextStreamResponse({
      headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } catch (error) {
    console.error('Velopipe chat error:', error);
    return json({ error: 'The assistant is temporarily unavailable.' }, 500);
  }
}


