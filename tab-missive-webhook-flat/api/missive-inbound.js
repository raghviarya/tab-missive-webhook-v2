// api/missive-inbound.js
// Framework: Vercel "Other" (Node 18+)
// Builds FULL thread by fetching each Missive message via /v1/messages/:id,
// then drafts a reply using OpenAI Assistants (file_search).

const OPENAI_API = "https://api.openai.com/v1";
const MISSIVE_API = "https://public.missiveapp.com/v1";

// Assistants v2 header is REQUIRED
const OPENAI_HEADERS = {
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  "Content-Type": "application/json",
  "OpenAI-Beta": "assistants=v2",
};

// Basic wait helper
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** User-requested HTML stripper (simple tag remover). */
function stripHtml(html = "") {
  return String(html || "").replace(/<[^>]*>/g, "");
}

/** Clamp big strings so we stay under model limits. Use a large cap for gpt-4.1. */
function clamp(text, max = 100000) {
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max) + "\n[...truncated for length...]";
}

/** Safe getter for the best display name + email for a message. */
function senderLabel(m) {
  const name =
    m.from_field?.name ||
    m.creator?.name ||
    m.creator?.email?.split("@")[0] ||
    "Unknown";
  const email = m.from_field?.address || m.creator?.email || "";
  return email ? `${name} <${email}>` : name;
}

/** Fetch ALL messages in a conversation, oldest → newest. */
async function fetchConversationMessages(conversationId) {
  // Try to pull up to 200 in one go; paginate if needed.
  // Missive uses standard pagination; if your threads are longer, you can extend this.
  const perPage = 200;
  let page = 1;
  let all = [];

  // First: list message IDs in the conversation
  while (true) {
    const listUrl =
      `${MISSIVE_API}/messages?search[conversation]=${encodeURIComponent(conversationId)}` +
      `&per_page=${perPage}&page=${page}`;

    const listResp = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${process.env.MISSIVE_API_TOKEN}` },
    });
    if (!listResp.ok) {
      const t = await listResp.text();
      throw new Error(`Missive list messages failed: ${t}`);
    }
    const listJson = await listResp.json();
    const ids = (listJson?.messages || []).map((m) => m.id);

    // For each id, fetch the full message
    // (Parallelize but cap concurrency a bit if needed; here we go wide for simplicity.)
    const full = await Promise.all(
      ids.map(async (id) => {
        const msgResp = await fetch(`${MISSIVE_API}/messages/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${process.env.MISSIVE_API_TOKEN}` },
        });
        if (!msgResp.ok) {
          const t = await msgResp.text();
          throw new Error(`Missive get message ${id} failed: ${t}`);
        }
        const j = await msgResp.json();
        return j?.message;
      })
    );

    all = all.concat(full);

    // Stop if we got fewer than perPage (likely last page)
    if (ids.length < perPage) break;
    page += 1;
    // Small pause to be polite
    await sleep(150);
  }

  // Sort oldest → newest
  all.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return all;
}

module.exports = async (req, res) => {
  try {
    // Health check
    if (req.method !== "POST") return res.status(200).send("ok");

    // 1) Parse Missive webhook
    const payload = req.body || {};
    const convoId = payload?.conversation?.id;
    if (!convoId) {
      return res.status(400).json({ error: "Missing conversation.id in Missive payload" });
    }

    // 2) Fetch conversation meta (for subject) — lightweight
    const convoResp = await fetch(`${MISSIVE_API}/conversations/${encodeURIComponent(convoId)}`, {
      headers: { Authorization: `Bearer ${process.env.MISSIVE_API_TOKEN}` },
    });
    if (!convoResp.ok) {
      const t = await convoResp.text();
      throw new Error(`Missive conversation fetch failed: ${t}`);
    }
    const convo = await convoResp.json();
    const subject = (convo.conversation?.subject || "").trim();

    // 3) Fetch FULL message objects via /v1/messages/:id (names + clean text)
    const messages = await fetchConversationMessages(convoId);

    // Build readable thread text with names, emails, times, and plain text
    const threadText = clamp(
      messages
        .map((m) => {
          const who = senderLabel(m);
          const when = m.created_at || "";
          const text =
            (m.text && m.text.trim()) ||
            (m.body ? stripHtml(m.body) : "") ||
            "";
          return `From: ${who}\nDate: ${when}\n---\n${text.trim()}`;
        })
        .join("\n\n------------------------\n\n"),
      120000 // allow a LOT of context; model will handle up to ~128k tokens
    );

    // === Prompt building (your refined rules + CTA logic) ===
    const PAYMENTS_URL =
      "https://business.tab.travel/payments?show=true&referrer_code=PaymentsR17&utm_source=Missive&utm_medium=email&utm_campaign=PaymentsR17";
    const CHECKOUT_URL =
      "https://business.tab.travel/checkout-flow?show=true&referrer_code=CheckoutR3&utm_source=Missive&utm_medium=email&utm_campaign=CheckoutR3";

    const suggestCheckout =
      /checkout/i.test(subject) || /checkout/i.test(threadText);
    const SUGGESTED_CTA_URL = suggestCheckout ? CHECKOUT_URL : PAYMENTS_URL;
    const SUGGESTED_CTA_LABEL = "Apply now";

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
        "You are Tab’s email drafting assistant for both customer service and outbound cold emails.",
        "Always output clean HTML only: <p>, <ul>, <ol>, <li>, <strong>, <em>, <a>. No signatures.",
        "Tone: professional, empathetic, concise, solution-oriented. Prefer 2–4 short paragraphs; use lists for steps.",
        "Do not overpromise. Do not set up accounts or complete tasks for the user; provide guidance and next steps.",
        "Adapt formality to the sender’s tone. For complaints: acknowledge, take responsibility where appropriate, give a clear plan to resolve.",
        'FIRST, check the "Canned responses" PDF for a relevant response and use it as-is.',
        'IF no suitable canned response exists, consult "Fin context" via file_search and synthesize an answer.',
        "Use file_search to ground facts; do not show citations, filenames, or IDs to the customer.",
        "Classification outputs ONLY with high confidence:",
        '- Automated/irrelevant bulk: output exactly "Automated response".',
        '- Spam/phishing: output exactly "spam".',
        '- Unsubscribe/angry/remove: output exactly "Unsubscribe".',
        '- Explicit WhatsApp handoff with phone number: output exactly "Whatsapp".',
        'Only output "I don\'t know" for a specific fact/policy that is truly unknown; not for generic "more info" asks.',
        `When appropriate, include a CTA hyperlink "${SUGGESTED_CTA_LABEL}". If thread/subject mentions checkout, use ${CHECKOUT_URL}, else ${PAYMENTS_URL}.`,
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

    // === Assistants v2: create thread, run, poll, get message ===
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

    const runCreate = await fetch(`${OPENAI_API}/threads/${thread.id}/runs`, {
      method: "POST",
      headers: OPENAI_HEADERS,
      body: JSON.stringify({
        assistant_id: process.env.ASSISTANT_ID,
        model: process.env.OPENAI_MODEL || "gpt-4.1", // large-context default
        temperature: 0.3,
      }),
    });
    if (!runCreate.ok) {
      const t = await runCreate.text();
      throw new Error(`OpenAI run create error: ${t}`);
    }
    const run = await runCreate.json();

    // Short poll so Missive rule doesn't time out
    let status = run.status;
    let tries = 0;
    while ((status === "queued" || status === "in_progress") && tries < 12) {
      await sleep(1200);
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

    const bodyHtml = /<\/?[a-z][\s\S]*>/i.test(out)
      ? out
      : `<p>${out.replace(/\n/g, "<br/>")}</p>`;

    // === Create the draft in Missive (email draft endpoint) ===
    const draftRes = await fetch(`${MISSIVE_API}/drafts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MISSIVE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        drafts: {
          conversation: convoId,
          subject: subject ? `Re: ${subject}` : "Re:",
          body: bodyHtml,
          quote_previous_message: false,
        },
      }),
    });
    if (!draftRes.ok) {
      const t = await draftRes.text();
      throw new Error(`Missive draft create error: ${t}`);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
};

