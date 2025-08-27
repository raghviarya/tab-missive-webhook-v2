// api/missive-inbound.js
// Framework: Vercel "Other" (Node 18+)
// Uses OpenAI Assistants (file_search) to draft HTML replies from the FULL Missive thread.

const OPENAI_API = "https://api.openai.com/v1";
const MISSIVE_API = "https://public.missiveapp.com/v1";

// --- Shared OpenAI headers (Assistants v2 requires the beta header) ---
const OPENAI_HEADERS = {
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  "Content-Type": "application/json",
  "OpenAI-Beta": "assistants=v2",
};

// Helper: wait
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Optional: clamp huge threads
function clamp(text, max = 16000) {
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max) + "\n[...truncated for length...]";
}

// Strip basic HTML tags if Missive gave HTML bodies
function stripHtml(html = "") {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/?(?:br|p|div|li|ul|ol|table|tr|td|th|hr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = async (req, res) => {
  try {
    // Health check / manual ping
    if (req.method !== "POST") return res.status(200).send("ok");

    // 1) Parse Missive webhook
    const payload = req.body || {};
    const convoId = payload?.conversation?.id;
    if (!convoId) {
      return res.status(400).json({ error: "Missing conversation.id in Missive payload" });
    }

    // 2) Fetch FULL thread from Missive
    const convoResp = await fetch(`${MISSIVE_API}/conversations/${encodeURIComponent(convoId)}`, {
      headers: { Authorization: `Bearer ${process.env.MISSIVE_API_TOKEN}` },
    });
    if (!convoResp.ok) {
      const t = await convoResp.text();
      throw new Error(`Missive conversation fetch failed: ${t}`);
    }
    const convo = await convoResp.json();

    // Build readable thread text (oldest → newest)
    const msgs = (convo.conversation?.messages || [])
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map((m) => {
        const who = m.creator?.email || m.from_field?.address || "unknown";
        const when = m.created_at || "";
        const text = m.text || (m.body ? stripHtml(m.body) : "");
        return `From: ${who}\nDate: ${when}\n---\n${text}`;
      })
      .join("\n\n------------------------\n\n");

    const threadText = clamp(msgs, 32000);
    const subject = (convo.conversation?.subject || "").trim();

    // 3) Create an OpenAI Thread with your prompt + full thread (Playground rules baked in)
const PAYMENTS_URL = "https://business.tab.travel/payments?show=true&referrer_code=PaymentsR17&utm_source=Missive&utm_medium=email&utm_campaign=PaymentsR17";
const CHECKOUT_URL = "https://business.tab.travel/checkout-flow?show=true&referrer_code=CheckoutR3&utm_source=Missive&utm_medium=email&utm_campaign=CheckoutR3";

// Simple heuristic: suggest Checkout CTA if subject or thread mentions "checkout"
const suggestCheckout = /checkout/i.test(subject) || /checkout/i.test(threadText);
const SUGGESTED_CTA_URL = suggestCheckout ? CHECKOUT_URL : PAYMENTS_URL;
const SUGGESTED_CTA_LABEL = "Apply now";

const systemHint =
  process.env.SYSTEM_HINT ||
  [
    // Core style & scope
    "You are Tab’s email drafting assistant for both customer service and outbound cold emails.",
    "Always output clean HTML only: <p>, <ul>, <ol>, <li>, <strong>, <em>, <a>. No signatures.",
    "Tone: professional, empathetic, concise, solution-oriented. Prefer 2–4 short paragraphs; use lists for steps.",
    "Do not overpromise. Do not set up accounts or complete tasks for the user; provide guidance and next steps.",
    "Adapt formality to the sender’s tone. For complaints: acknowledge, take responsibility where appropriate, give a clear plan to resolve.",

    // Knowledge use (file_search)
    'When answering, FIRST check the **"Canned responses"** PDF for a relevant response and use it as-is.',
    'Only if there is no matching canned response, or parts must be adapted, may you consult the **"Fin context"** file via file_search.',
    "Use file_search to ground facts, but do not show citations, doc names, or file IDs to the customer.",

    // Hard classification rules (single-token outputs)
    'If the incoming message is clearly an automated response or irrelevant bulk marketing (e.g., newsletter, OOO, generic acknowledgment, template blast), reply **exactly**: "Automated response".',
    'If the message appears to be spam or phishing (fake invoices, payment scams, suspicious requests/attachments), reply **exactly**: "spam".',
    'If someone complains, asks to unsubscribe, or expresses anger, reply **exactly**: "Unsubscribe".',
    'If the message asks to be contacted on WhatsApp or another messenger and includes a phone number, reply **exactly**: "Whatsapp".',
    'If you cannot find the information or do not explicitly know the answer, reply **exactly**: "I don\'t know". Do not guess.',

    // CTA logic
    `When appropriate, include a clear call-to-action hyperlink labeled "${SUGGESTED_CTA_LABEL}".`,
    `If the previous email explicitly mentions the checkout flow, use: ${CHECKOUT_URL}`,
    `Otherwise use: ${PAYMENTS_URL}`,

  ].join(" ");

const userMessage = [
  `SUBJECT: ${subject || "(no subject)"}`,

  "",
  "TASK: Draft a concise, helpful HTML reply that addresses the most recent customer message. Use 'Canned responses' first; otherwise adapt from 'Fin context' if needed. Apply the strict classification rules when they match (respond with the exact single word/phrase). Do not include signatures.",

  "",
  "CTA POLICY:",
  `- Default CTA: <a href="${PAYMENTS_URL}">Apply now</a>`,
  `- If thread/subject mentions checkout: <a href="${CHECKOUT_URL}">Apply now</a>`,
  `- Suggested CTA for this thread: <a href="${SUGGESTED_CTA_URL}">Apply now</a>`,

  "",
  "CONTEXT (FULL THREAD, oldest → newest):",
  threadText,
].join("\n");

    // Create Thread (Assistants v2 header required)
    const threadCreate = await fetch(`${OPENAI_API}/threads`, {
      method: "POST",
      headers: OPENAI_HEADERS,
      body: JSON.stringify({
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    if (!threadCreate.ok) {
      const t = await threadCreate.text();
      throw new Error(`OpenAI thread create error: ${t}`);
    }
    const thread = await threadCreate.json();

    // 4) Run the Assistant (which has file_search + your docs)
    const runCreate = await fetch(`${OPENAI_API}/threads/${thread.id}/runs`, {
      method: "POST",
      headers: OPENAI_HEADERS,
      body: JSON.stringify({
        assistant_id: process.env.ASSISTANT_ID,
        model: process.env.OPENAI_MODEL || undefined, // optional override
      }),
    });
    if (!runCreate.ok) {
      const t = await runCreate.text();
      throw new Error(`OpenAI run create error: ${t}`);
    }
    const run = await runCreate.json();

    // 5) Poll run status (short window so Missive doesn't time out)
    let status = run.status;
    let tries = 0;
    while ((status === "queued" || status === "in_progress") && tries < 12) {
      await sleep(1200); // ~14–15s max
      const r = await fetch(`${OPENAI_API}/threads/${thread.id}/runs/${run.id}`, {
        headers: OPENAI_HEADERS,
      });
      const j = await r.json();
      status = j.status;
      tries++;
    }
    if (status !== "completed") {
      throw new Error(`Assistant run did not complete (status: ${status})`);
    }

    // 6) Read the Assistant's final message
    const msgsResp = await fetch(`${OPENAI_API}/threads/${thread.id}/messages`, {
      headers: OPENAI_HEADERS,
    });
    if (!msgsResp.ok) {
      const t = await msgsResp.text();
      throw new Error(`OpenAI messages fetch error: ${t}`);
    }
    const threadMsgs = await msgsResp.json();
    const assistantMsg = threadMsgs.data.find((m) => m.role === "assistant");
    const out =
      assistantMsg?.content?.map((c) => c.text?.value || "").join("\n").trim() ||
      "<p>Thanks for reaching out.</p>";

    // Ensure HTML (Assistants often return plain text)
    const bodyHtml = /<\/?[a-z][\s\S]*>/i.test(out)
      ? out
      : `<p>${out.replace(/\n/g, "<br/>")}</p>`;

    // 7) Create a draft reply in the same Missive conversation (via /drafts)
const draftRes = await fetch(`${MISSIVE_API}/drafts`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.MISSIVE_API_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    drafts: {
      conversation: convoId,                         // reply in this conversation
      subject: subject ? `Re: ${subject}` : "Re:",   // optional
      body: bodyHtml,                                // NOTE: field is "body" (HTML or text)
      quote_previous_message: false                  // don't auto-quote
    }
  }),
});

if (!draftRes.ok) {
  throw new Error(`Missive draft create error: ${await draftRes.text()}`);
}


    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
};
