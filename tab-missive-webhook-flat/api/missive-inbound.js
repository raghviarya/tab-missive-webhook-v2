// api/missive-inbound.js
// Framework: Vercel "Other" (Node 18+)
// Builds FULL thread by listing /v1/conversations/:id/messages (limit=10 with pagination),
// then fetching each /v1/messages/:id. Strips HTML, includes sender name+email+time,
// drafts a reply via OpenAI Assistants (file_search), forces From address, and appends signature.

const OPENAI_API = "https://api.openai.com/v1";
const MISSIVE_API = "https://public.missiveapp.com/v1";

// Assistants v2 header is REQUIRED
const OPENAI_HEADERS = {
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  "Content-Type": "application/json",
  "OpenAI-Beta": "assistants=v2",
};

// Wait helper
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Simple HTML stripper (requested regex). */
function stripHtml(html = "") {
  return String(html || "").replace(/<[^>]*>/g, "");
}

/** Clamp big strings to avoid blowing context limits (very generous). */
function clamp(text, max = 120000) {
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max) + "\n[...truncated for length...]";
}

/** Build "Name <email>" best-effort label for a message. */
function senderLabel(m) {
  const name =
    m.from_field?.name ||
    m.creator?.name ||
    (m.creator?.email ? m.creator.email.split("@")[0] : "") ||
    "Unknown";
  const email = m.from_field?.address || m.creator?.email || "";
  return email ? `${name} <${email}>` : name;
}

/** Ensure visible paragraph spacing in Missive: insert <p><br></p> between <p> blocks. */
function addParagraphSpacing(html) {
  return String(html || "").replace(/<\/p>\s*<p>/g, "</p><p><br></p><p>");
}

/** Append a fixed HTML signature if it's not already present. */
function appendSignature(html) {
  const sig = `<p><br></p><p>Best regards,</p><p>Raghvi</p>`;
  if (html.includes("Best regards") && html.includes("Raghvi")) return html;
  return html + sig;
}

/** Fetch ALL messages in a conversation (newest→oldest from API; we'll re-sort oldest→newest).
 * Uses /v1/conversations/:id/messages (limit max 10) + ?until pagination,
 * then hydrates each message via /v1/messages/:id to get full bodies.
 * Includes a hard cap to avoid long runtimes.
 */
async function fetchConversationMessages(conversationId) {
  const limit = 10;            // Missive max for this endpoint
  const MAX_PAGES = 6;         // Cap total (6 * 10 = 60 messages) — adjust if you like
  let until = undefined;       // pagination cursor (oldest delivered_at from previous page)
  let collected = [];
  let pages = 0;

  while (pages < MAX_PAGES) {
    const url = new URL(`${MISSIVE_API}/conversations/${encodeURIComponent(conversationId)}/messages`);
    url.searchParams.set("limit", String(limit));
    if (until !== undefined && until !== null) {
      url.searchParams.set("until", String(until));
    }

    const listResp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${process.env.MISSIVE_API_TOKEN}` },
    });
    if (!listResp.ok) {
      const t = await listResp.text();
      throw new Error(`Missive list conversation messages failed: ${t}`);
    }
    const listJson = await listResp.json();
    const page = Array.isArray(listJson?.messages) ? listJson.messages : [];
    if (page.length === 0) break;

    // Hydrate each message to get the full body/html/attachments
    const full = await Promise.all(
      page.map(async (stub) => {
        const id = stub.id;
        const msgResp = await fetch(`${MISSIVE_API}/messages/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${process.env.MISSIVE_API_TOKEN}` },
        });
        if (!msgResp.ok) {
          const t = await msgResp.text();
          throw new Error(`Missive get message ${id} failed: ${t}`);
        }
        const j = await msgResp.json();
        // Single message object may be returned as { message: {...} } (most orgs) or { messages: {...} }
        return j?.message || j?.messages || j;
      })
    );

    collected = collected.concat(full);

    // API returns newest→oldest. Move cursor to the OLDEST delivered_at we just saw.
    const deliveredAts = page.map((p) => p.delivered_at).filter((v) => v !== undefined && v !== null);
    const oldestInPage = deliveredAts.length ? Math.min(...deliveredAts) : undefined;

    // Stop if we got fewer than limit OR can't advance the cursor
    if (page.length < limit || !oldestInPage || oldestInPage === until) break;
    until = oldestInPage;
    pages += 1;

    // small pause to be polite
    await sleep(120);
  }

  // Log how many we actually pulled (shows in Vercel logs)
  console.log(`Missive messages fetched: ${collected.length} (pages=${pages}, cap=${MAX_PAGES * limit})`);

  // Present oldest→newest for the model
  collected.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return collected;
}

module.exports = async (req, res) => {
  try {
    // Health check / GET ping
    if (req.method !== "POST") return res.status(200).send("ok");

    // 1) Parse Missive webhook
    const payload = req.body || {};
    const convoId = payload?.conversation?.id;
    if (!convoId) {
      return res.status(400).json({ error: "Missing conversation.id in Missive payload" });
    }

    // 2) Fetch conversation meta (subject)
    const convoResp = await fetch(`${MISSIVE_API}/conversations/${encodeURIComponent(convoId)}`, {
      headers: { Authorization: `Bearer ${process.env.MISSIVE_API_TOKEN}` },
    });
    if (!convoResp.ok) {
      const t = await convoResp.text();
      throw new Error(`Missive conversation fetch failed: ${t}`);
    }
    const convo = await convoResp.json();
    const subject = (convo.conversation?.subject || "").trim();

    // 3) Fetch full messages (names + bodies) and build the thread text
    const messages = await fetchConversationMessages(convoId);

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
        .join("\n\n------------------------\n\n")
    );

    // === Prompt: refined rules + CTA logic ===
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
        "Use <p> for every paragraph. Keep each paragraph to 2–4 sentences max. Insert blank spacer paragraphs (<p><br></p>) between paragraphs for readability.",
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

    // Ensure HTML, then enforce spacing + signature
    let finalHtml = /<\/?[a-z][\s\S]*>/i.test(out)
      ? out
      : `<p>${out.replace(/\n/g, "<br/>")}</p>`;
    finalHtml = addParagraphSpacing(finalHtml);
    finalHtml = appendSignature(finalHtml);

    // 7) Create the email draft in Missive (force From: hello@tab.travel)
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
          body: finalHtml,
          quote_previous_message: false,
          from_field: {
            address: "hello@tab.travel",
            name: "Raghvi",
          },
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
