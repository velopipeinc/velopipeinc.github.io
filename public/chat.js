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

    // Strict 21-sat cap: enforce the 210 character input limit boundary safely
    const truncatedPrompt = typeof lastMessage.content === 'string' ? lastMessage.content.slice(0, 210) : '';
    if (!truncatedPrompt) return json({ error: 'Empty prompt context.' }, 400);
    if (!process.env.LN_API_KEY) return json({ error: 'ln.bot gateway key is missing in Vercel settings.' }, 503);

    // STEP 1: Hit Sats4AI natively to trigger the L402 paywall challenge
    const SATS4AI_URL = "https://sats4ai.com";
    const aiPayload = { prompt: `${systemPrompt}\nUser request: ${truncatedPrompt}`, model: "kimi-k3" };

    const aiChallengeResponse = await fetch(SATS4AI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(aiPayload)
    });

    // STEP 2: Intercept the 402 Paywall required challenge status code
    if (aiChallengeResponse.status === 402) {
      const authHeader = aiChallengeResponse.headers.get("WWW-Authenticate");
      if (!authHeader) return json({ error: "L402 challenge header missing." }, 502);

      const invoiceMatch = authHeader.match(/invoice="([^"]+)"/);
      if (!invoiceMatch) return json({ error: "Could not safely decode invoice token." }, 502);
      const lightningInvoice = invoiceMatch[1]; // Isolate the raw invoice string cleanly

      // STEP 3: Automated Outbound Payment using the real production ln.bot wallet router
      const LNBOT_PAY_URL = "https://ln.bot";
      const walletPayment = await fetch(LNBOT_PAY_URL, {
        method: "POST",
        headers: { 
          "Authorization": `Bearer ${process.env.LN_API_KEY}`, 
          "Content-Type": "application/json" 
        },
        body: JSON.stringify({ bolt11: lightningInvoice }) // Feeds invoice parameters securely
      });

      if (!walletPayment.ok) {
        const walletError = await walletPayment.text();
        console.error("ln.bot payment failure details:", walletError);
        return json({ error: "Automated wallet routing transaction failed." }, 402);
      }
      
      const walletData = await walletPayment.json();
      const preimage = walletData.preimage;

      // STEP 4: Authorized AI Request: Send the settlement preimage back to unlock the stream
      const finalizedStream = await fetch(SATS4AI_URL, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `L402 ${lightningInvoice}:${preimage}` 
        },
        body: JSON.stringify(aiPayload)
      });

      if (!finalizedStream.ok) return json({ error: "AI gateway token authorization verification failed." }, 502);

      // Direct Stream Handshake: Pass-through response chunks directly back to GitHub Pages
      return new Response(finalizedStream.body, {
        headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    // Direct Return Fallback if the endpoint provides a free completion pass bypass
    return new Response(aiChallengeResponse.body, {
      headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
    });

  } catch (error) {
    console.error("Vercel Edge function execution crash:", error);
    return json({ error: 'Runtime error processing proxy pipeline.' }, 500);
  }
}
