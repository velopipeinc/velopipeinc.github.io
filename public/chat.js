export const config = { runtime: 'edge' };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-cache, no-transform',
};

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
    const lastMessage = messages[messages.length - 1];

    if (!lastMessage || !lastMessage.content) return json({ error: 'A message is required.' }, 400);

    // Strict 21-sat cap (210 characters maximum to fit your transfer balance)
    const truncatedPrompt = typeof lastMessage.content === 'string' ? lastMessage.content.slice(0, 210) : '';
    if (!truncatedPrompt) return json({ error: 'Empty prompt context.' }, 400);
    if (!process.env.LN_API_KEY) return json({ error: 'ln.bot gateway key is missing in Vercel settings.' }, 503);

    const SATS4AI_URL = "https://sats4ai.com";
    const aiPayload = { prompt: `${systemPrompt}\nUser request: ${truncatedPrompt}`, model: "kimi-k3" };

    // Step A: Request the initial L402 paywall challenge from the AI engine
    const aiChallengeResponse = await fetch(SATS4AI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(aiPayload)
    });

    if (aiChallengeResponse.status === 402) {
      const authHeader = aiChallengeResponse.headers.get("WWW-Authenticate");
      const invoiceMatch = authHeader.match(/invoice="([^"]+)"/);
      if (!invoiceMatch) return json({ error: "Could not parse invoice string." }, 502);
      const lightningInvoice = invoiceMatch[1];

      // Step B: Route automated payment through official ln.bot endpoint mapping
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

      // Step C: Submit proof back to Sats4AI to unlock the live streaming text response
      const finalizedStream = await fetch(SATS4AI_URL, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `L402 ${lightningInvoice}:${preimage}` 
        },
        body: JSON.stringify(aiPayload)
      });

      return new Response(finalizedStream.body, {
        headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    return new Response(aiChallengeResponse.body, {
      headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } catch (error) {
    console.error("Backend error:", error);
    return json({ error: 'Runtime routing error.' }, 500);
  }
}
