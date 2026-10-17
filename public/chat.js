export const config = { runtime: 'edge' };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-cache, no-transform',
};

const systemPrompt = `You are the Velopipe OpenAI GPT Assistant. Maintain a professional, clear, and modern tone.
Capabilities & Information Map:
1. Jump to Sections: Electronics Line Cards (#electronics-section), Automotive Innovations (#automotive-section).
2. Downloads: Strategy Map (PDF) [strategymap.pdf].
Instructions: Keep output concise and formatted using bold tags where helpful.`;

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
    const lastMessage = messages[messages.length - 1];

    if (!lastMessage || !lastMessage.content) return json({ error: 'A message is required.' }, 400);

    // Enforce 210 character input limit to fit within your 21 satoshi bounds
    const truncatedPrompt = typeof lastMessage.content === 'string' ? lastMessage.content.slice(0, 210) : '';
    if (!truncatedPrompt) return json({ error: 'Empty prompt context.' }, 400);
    if (!process.env.LN_API_KEY) return json({ error: 'ln.bot execution key is unconfigured.' }, 503);

    // Target the native ln.bot unified AI execution endpoint
    const LNBOT_AI_URL = "https://ln.bot";
    const payload = {
      model: "openai/gpt-4o-mini",
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: truncatedPrompt }
      ]
    };

    // Execute the request directly using your uk_... key to pay per token out of your 21 sats balance
    const response = await fetch(LNBOT_AI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.LN_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("ln.bot AI Gateway Error:", errorText);
      return json({ error: "AI model routing failed." }, response.status);
    }

    // Pass the text stream back to GitHub Pages
    return new Response(response.body, {
      headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
    });

  } catch (error) {
    console.error("Vercel GPT proxy routing crash:", error);
    return json({ error: 'Runtime error routing OpenAI pipeline.' }, 500);
  }
}
