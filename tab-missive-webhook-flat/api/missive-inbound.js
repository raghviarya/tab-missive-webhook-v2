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

    // 3) Create an OpenAI Thread with your prompt + full thread (refined rules)
const PAYMENTS_URL = "https://business.tab.travel/payments?show=true&referrer_code=PaymentsR17&utm_source=Missive&utm_medium=email&utm_campaign=PaymentsR17";
const CHECKOUT_URL = "https://business.tab.travel/checkout-flow?show=true&referrer_code=CheckoutR3&utm_source=Missive&utm_medium=email&utm_campaign=CheckoutR3";

// Heuristic: prefer Checkout CTA if subject/thread mention "checkout"
const suggestCheckout = /checkout/i.test(subject) || /checkout/i.test(threadText);
const SUGGESTED_CTA_URL = suggestCheckout ? CHECKOUT_URL : PAYMENTS_URL;
const SUGGESTED_CTA_LABEL = "Apply now";

// Helper note that the model can follow for fallback overviews
const FALLBACK_OVERVIEW = `
If the user asks for "more information" or a general overview (e.g., "send more info", "tell me more"):
- Provide a concise overview in HTML:
  <p>1–2 sentence intro</p>
  <ul>
    <li>What it is (plain language)</li>
    <li>Core benefits (2–4 bullets)</li>
    <li>What the user can do next (1–2 bullets)</li>
  </ul>
- End with a CTA hyperlink: <a href="${SUGGESTED_CTA_URL}">${SUGGESTED_CTA_LABEL}</a>.
- Do NOT say "I don't know" in these generic cases; use available high-level info from files and prior messages.
`.trim();

const systemHint =
  process.env.SYSTEM_HINT ||
  [
    // Scope & tone
    "You are Tab’s email drafting assistant for both customer service and outbound cold emails.",
    "Always output clean HTML only: <p>, <ul>, <ol>, <li>, <strong>, <em>, <a>. No signatures.",
    "Tone: professional, empathetic, concise, solution-oriented. Prefer 2–4 short paragraphs; use lists for steps.",
    "Do not overpromise. Do not set up accounts or complete tasks for the user; provide guidance and next steps.",
    "Adapt formality to the sender’s tone. For complaints: acknowledge, take responsibility where appropriate, give a clear plan to resolve.",

    // Knowledge policy
    'FIRST, check the "Canned responses" PDF for a relevant response and use it as-is (lightly adapt details only as needed).',
    'IF no suitable canned response exists, consult "Fin context" via file_search and synthesize an answer.',
    "Use file_search to ground facts; do not show citations, filenames, or IDs to the customer.",

    // Strict classifications — ONLY with high confidence
    'Only if you are HIGHLY CONFIDENT the message matches, reply with the exact single token:',
    '- Automated/irrelevant bulk (OOO/newsletter/template marketing): output exactly "Automated response".',
    '- Spam/phishing (fake invoices, payment scams, suspicious attachments/requests): output exactly "spam".',
    '- Unsubscribe/angry/complaint requesting removal: output exactly "Unsubscribe".',
    '- Explicit WhatsApp handoff with phone number: output exactly "Whatsapp".',
    // Guardrail for "I don't know"
    'Only output "I don\'t know" if the user asks for a specific fact/policy that is NOT in files or prior messages and cannot be answered with a truthful, high-level explanation. Do NOT use "I don\'t know" for generic requests like "send more information".',

    // CTA logic
    `When appropriate, include a clear CTA hyperlink labeled "${SUGGESTED_CTA_LABEL}".`,
    `If thread/subject explicitly mentions checkout flow, use: ${CHECKOUT_URL}`,
    `Otherwise use: ${PAYMENTS_URL}`,

    // Fallback pattern for generic info requests
    FALLBACK_OVERVIEW,
  ].join(" ");

const userMessage = [
  `SUBJECT: ${subject || "(no subject)"}`,
  "",
  "TASK: Draft a concise, helpful HTML reply that addresses the most recent customer message. Apply the classification rules ONLY if the match is obvious; otherwise give a normal reply.",
  "Follow the knowledge policy (Canned responses → Fin context). For general 'more info' asks, use the fallback overview pattern.",
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
