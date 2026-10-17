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

    // Enforce your strict 21-sat budget ceiling (210 characters maximum text barrier)
    const truncatedPrompt = typeof lastMessage.content === 'string' ? lastMessage.content.slice(0, 210) : '';
    if (!truncatedPrompt) return json({ error: 'Empty prompt context.' }, 400);
    if (!process.env.LN_API_KEY) return json({ error: 'ln.bot key missing in Vercel.' }, 503);

    const SATS4AI_URL = "https://sats4ai.com";
    const aiPayload = { prompt: `${systemPrompt}\nUser request: ${truncatedPrompt}`, model: "kimi-k3" };

    // Step A: Request the initial L402 paywall challenge
    const aiChallengeResponse = await fetch(SATS4AI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(aiPayload)
    });

    if (aiChallengeResponse.status === 402) {
      const authHeader = aiChallengeResponse.headers.get("WWW-Authenticate");
      if (!authHeader) return json({ error: "L402 challenge header missing." }, 502);

      const invoiceMatch = authHeader.match(/invoice="([^"]+)"/);
      if (!invoiceMatch) return json({ error: "Could not parse invoice string." }, 502);
      const lightningInvoice = invoiceMatch[1]; // Correct array string extraction string

      // Step B: Auto-spend micro-payment through the production ln.bot wallet payment engine
      const walletPayment = await fetch("https://ln.bot", {
        method: "POST",
        headers: { 
          "Authorization": `Bearer ${process.env.LN_API_KEY}`, 
          "Content-Type": "application/json" 
        },
        body: JSON.stringify({ bolt11: lightningInvoice })
      });

      if (!walletPayment.ok) return json({ error: "Automated wallet routing transaction failed." }, 402);
      const walletData = await walletPayment.json();
      const preimage = walletData.preimage;

      // Step C: Submit proof back to Sats4AI to unlock the text generation payload
      const finalizedResponse = await fetch(SATS4AI_URL, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `L402 ${lightningInvoice}:${preimage}` 
        },
        body: JSON.stringify(aiPayload)
      });

      if (!finalizedResponse.ok) return json({ error: "AI gateway token validation failed." }, 502);

      // FIXED: Safely unpack the ReadableStream body using Edge runtime native constructors
      const responseText = await finalizedResponse.text();
      return new Response(responseText, {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    const fallbackText = await aiChallengeResponse.text();
    return new Response(fallbackText, {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
    });

  } catch (error) {
    console.error("Vercel Edge function processing error:", error);
    return json({ error: 'Runtime error processing proxy pipeline.' }, 500);
  }
}
