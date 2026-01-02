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

/** Ensure proper paragraph spacing in Missive: single line between paragraphs. */
function addParagraphSpacing(html) {
  return String(html || "").replace(/<\/p>\s*<p>/g, "</p><p><br></p><p>");
}

/** Append the proper Tab signature if it's not already present. */
function appendSignature(html) {
  const sig = `<p><br></p><p>Raghvi</p><p>—</p><p>Tab Support</p><p><br></p><p>Tab.</p><p><a href="https://business.tab.travel">business.tab.travel</a></p><p><br></p><p>Tab Labs Ltd is a company registered in England and Wales. Registered number: 09339113. Registered office: 6th Floor, 1 London Wall, London, EC2Y 5EB, UK.</p>`;
  if (html.includes("Raghvi") && html.includes("Tab Support")) return html;
  return html + sig;
}

/** Fetch ALL messages in a conversation (newest→oldest from API; we'll re-sort oldest→newest).
 * Uses /v1/conversations/:id/messages (limit max 10) + ?until pagination,
 * then hydrates each message via /v1/messages/:id to get full bodies.
 * Includes a hard cap to avoid long runtimes.
 */
async function fetchConversationMessages(conversationId) {
  const limit = 10; // Missive max for this endpoint
  const MAX_PAGES = 6; // Cap total (6 * 10 = 60 messages) — adjust if you like
  let until = undefined; // pagination cursor (oldest delivered_at from previous page)
  let collected = [];
  let pages = 0;

  while (pages < MAX_PAGES) {
    const url = new URL(
      `${MISSIVE_API}/conversations/${encodeURIComponent(conversationId)}/messages`
    );
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
  console.log(
    `Missive messages fetched: ${collected.length} (pages=${pages}, cap=${MAX_PAGES * limit})`
  );

  // Present oldest→newest for the model
  collected.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return collected;
}

/* === Minimal helpers for reply target + greeting + CTA routing === */
function isFromTabAddress(addr = "") {
  const a = String(addr).toLowerCase().trim();
  return a.endsWith("@tab.travel") || a === "hello@tab.travel";
}
function isFromTab(m = {}) {
  const addr = m?.from_field?.address || m?.creator?.email || "";
  return isFromTabAddress(addr);
}
/** Latest message from the *external* sender (not Tab). */
function getReplyTarget(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isFromTab(m)) return m;
  }
  return messages[messages.length - 1];
}
function firstNameFrom(message) {
  const full =
    message?.from_field?.name ||
    message?.creator?.name ||
    (message?.from_field?.address || message?.creator?.email || "")
      .split("@")[0]
      .replace(/\./g, " ") ||
    "";
  const first = String(full).trim().split(/\s+/)[0];
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "";
}
function replyStartsWithGreeting(html = "") {
  const txt = String(html).replace(/<[^>]*>/g, " ").trim().toLowerCase();
  return /^(hi|hello|dear)\b/.test(txt);
}

/* UTM (F25) */
const WEBSITE_BASE = "https://business.tab.travel";
const UTM_SUFFIX =
  "show=true&referrer_code=F25&utm_source=Missive&utm_medium=email&utm_campaign=F25";

function joinUrl(path = "/") {
  return `${WEBSITE_BASE.replace(/\/+$/, "")}${String(path || "/").replace(/^\/*/, "/")}`;
}
function withUtms(url) {
  return url.includes("?") ? `${url}&${UTM_SUFFIX}` : `${url}?${UTM_SUFFIX}`;
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
    const convoResp = await fetch(
      `${MISSIVE_API}/conversations/${encodeURIComponent(convoId)}`,
      {
        headers: { Authorization: `Bearer ${process.env.MISSIVE_API_TOKEN}` },
      }
    );
    if (!convoResp.ok) {
      const t = await convoResp.text();
      throw new Error(`Missive conversation fetch failed: ${t}`);
    }
    const convo = await convoResp.json();
    // The API returns conversations array, so we need to access the first conversation
    const conversation = convo.conversations?.[0];
    const subject = (conversation?.subject || conversation?.latest_message_subject || "").trim();
    console.log("Conversation details:", JSON.stringify(convo, null, 2));
    console.log("Raw conversation subject:", conversation?.subject);
    console.log("Raw latest message subject:", conversation?.latest_message_subject);
    console.log("Processed subject:", subject);
    console.log("Subject length:", subject.length);

    // 3) Fetch full messages (names + bodies) and build the thread text
    const messages = await fetchConversationMessages(convoId);
    console.log("Messages fetched:", messages.length);
    console.log("Last message from:", messages[messages.length - 1]?.from_field);
    const threadText = clamp(
      messages
        .map((m) => {
          const who = senderLabel(m);
          const when = m.created_at || "";
          const text = (m.text && m.text.trim()) || (m.body ? stripHtml(m.body) : "") || "";
          return `From: ${who}\nDate: ${when}\n---\n${text.trim()}`;
        })
        .join("\n\n------------------------\n\n")
    );

    // Choose reply target (latest external sender)
    const replyTarget = getReplyTarget(messages);

    // === Prompt: refined rules + CTA logic ===
    const SUGGESTED_CTA_URL = withUtms(joinUrl("/"));

    const FALLBACK_OVERVIEW = `
If the user asks for "more information" or a general overview (e.g., "send more info", "tell me more"):
- Provide a concise overview in HTML:
  <p>1–2 sentence intro</p>
  <ul>
    <li>What it is (plain language)</li>
    <li>Core benefits (2–4 bullets)</li>
    <li>What the user can do next (1–2 bullets)</li>
  </ul>
- End with a short, friendly sentence that includes a hyperlink to ${SUGGESTED_CTA_URL} (for example: "You can find out more and apply on our website").
- Do NOT say "I don't know" in these generic cases; use available high-level info from files and prior messages.
`.trim();

    const systemHint =
      process.env.SYSTEM_HINT ||
      [
        "You are Tab's email drafting assistant for both customer service and outbound cold emails.",
        "Use <p> for every paragraph. Keep each paragraph to 2–4 sentences max. The system will automatically add proper spacing between paragraphs.",
        "Tone: professional, empathetic, concise, solution-oriented. Prefer 2–4 short paragraphs; use lists for steps.",
        "Do not overpromise. Do not set up accounts or complete tasks for the user; provide guidance and next steps.",
        "Adapt formality to the sender's tone. For complaints: acknowledge, take responsibility where appropriate, give a clear plan to resolve.",
        'IMPORTANT: You have access to file_search which will automatically search your knowledge base files. Use this information to provide accurate responses.',
        'PRIORITY ORDER: 1) ALWAYS check "Canned responses.pdf" FIRST - if there is a relevant canned response, use it exactly as written. 2) Only if no suitable canned response exists, then consult "Fin context.pdf" and synthesize an answer.',
        "When using canned responses, adapt them slightly to the specific customer situation but keep the core message and structure.",
        "Use file_search to ground facts; do not show citations, filenames, or IDs to the customer.",
        "FIRST, ALWAYS check for these classifications before drafting any reply:",
        '- Automated/irrelevant bulk emails: output ONLY "Automated response" (nothing else)',
        '- Spam/phishing attempts: output ONLY "spam" (nothing else)',
        '- Unsubscribe/angry/remove requests: output ONLY "Unsubscribe" (nothing else)',
        '- Explicit WhatsApp handoff requests with phone number: output ONLY "Whatsapp" (nothing else)',
        "ONLY if none of these classifications apply, then proceed to draft a helpful reply.",
        'Only output "I don\'t know" for a specific fact/policy that is truly unknown; not for generic "more info" asks.',
        `When appropriate, include a short, friendly CTA sentence that links to ${SUGGESTED_CTA_URL}. The exact wording is up to you; it could be similar to "You can find out more and apply on our website." Include the CTA URL here. Always use the CTA when you can once in an email unless it really doesn't make sense to.`,
        FALLBACK_OVERVIEW,
      ].join(" ");

    const userMessage = [
      `SYSTEM INSTRUCTIONS: ${systemHint}`,
      "",
      `SUBJECT: ${subject || "(no subject)"}`,
      "",
      "TASK: FIRST check if this message should be classified as automated/spam/unsubscribe/whatsapp. If it matches any classification, output ONLY that classification word. If NO classification matches, then draft a concise, helpful HTML reply that addresses the most recent customer message.",
      "Follow the knowledge policy (Canned responses → Fin context). For general 'more info' asks, use the fallback overview pattern.",
      "",
      "CRITICAL: You MUST ALWAYS use the file_search tool to search the knowledge base before responding. Even if you think you know the answer, you must search for relevant information first. This is mandatory for every response.",
      "",
      "SEARCH INSTRUCTIONS: Use file_search to look for:",
      "1. Canned responses related to the customer's question",
      "2. Context about Tab's services, policies, or procedures",
      "3. Any relevant information that could help answer the customer's question",
      "Search for terms related to the customer's message and the conversation context.",
      "",
      "CTA POLICY:",
      `- When you include a CTA, add a short sentence that naturally links to ${SUGGESTED_CTA_URL} (for example: "You can find out more and apply on our website"). Do not always use the exact same wording; choose phrasing that fits the rest of the email. Embed CTA URL here. Do not include the CTA URL as a full link - always embed it.`,
      "",
      "CONTEXT (FULL THREAD, oldest → newest):",
      threadText,
    ].join("\n");

    // === Responses API with file_search (correct approach) ===
    const requestBody = {
      model: process.env.OPENAI_MODEL || "gpt-5",
      input: userMessage,
      tools: [
        {
          type: "file_search",
          vector_store_ids: [String(process.env.VECTOR_STORE_ID)], // Required for file search
          max_num_results: 10, // Limit results
        },
      ],
      tool_choice: "auto", // Ensure tools are used automatically
      // Note: temperature not supported with GPT-5 in Responses API
    };
    console.log("Request body:", JSON.stringify(requestBody, null, 2));
    console.log("Vector store ID being used:", String(process.env.VECTOR_STORE_ID));

    const responseCreate = await fetch(`${OPENAI_API}/responses`, {
      method: "POST",
      headers: OPENAI_HEADERS,
      body: JSON.stringify(requestBody),
    });
    if (!responseCreate.ok) {
      const t = await responseCreate.text();
      throw new Error(`OpenAI response create error: ${t}`);
    }
    const response = await responseCreate.json();
    // Debug: Log the full response to see if file search was used
    console.log("OpenAI Response:", JSON.stringify(response, null, 2));

    // Check if file search was used
    const fileSearchOutput = response.output?.find((item) => item.type === "file_search_call");
    if (fileSearchOutput) {
      console.log("File search was used:", fileSearchOutput);
    } else {
      console.log("WARNING: No file search was used in this response");
    }

    // Extract the message content from the response
    const messageOutput = response.output?.find((item) => item.type === "message");
    const out = messageOutput?.content?.[0]?.text || "<p>Thanks for reaching out.</p>";

    // Ensure HTML, add greeting, then enforce spacing (signature handled by Missive)
    let finalHtml = /<\/?[a-z][\s\S]*>/i.test(out)
      ? out
      : `<p>${out.replace(/\n/g, "<br/>")}</p>`;

    const recipientFirst = firstNameFrom(replyTarget);
    const greetingHtml = `<p>Hi ${recipientFirst || "there"},</p>`;

    if (!replyStartsWithGreeting(finalHtml)) {
      finalHtml = greetingHtml + finalHtml;
    } else if (recipientFirst) {
      // If it's "Hi there", personalise it
      finalHtml = finalHtml.replace(
        /(<p>)(\s*hi\s+there\s*,?\s*)(<\/p>)/i,
        `<p>Hi ${recipientFirst},</p>`
      );
    }

    finalHtml = addParagraphSpacing(finalHtml);

    // Note: Signature is handled automatically by Missive for hello@tab.travel

    // 7) Create the email draft in Missive (force From: hello@tab.travel)
    // Don't add "Re:" if the subject already starts with "Re:"
    const draftSubject = subject
      ? subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`
      : "Re:";
    console.log("Draft subject being sent:", draftSubject);

    const draftRes = await fetch(`${MISSIVE_API}/drafts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MISSIVE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        drafts: {
          conversation: convoId,
          subject: draftSubject,
          body: appendSignature(finalHtml),
          quote_previous_message: false,
          from_field: {
            address: "hello@tab.travel",
            name: "Raghvi",
          },
          to_fields: [
            {
              address: replyTarget?.from_field?.address,
              name: replyTarget?.from_field?.name,
            },
          ],
          send: false,
        },
      }),
    });
    if (!draftRes.ok) {
      const t = await draftRes.text();
      throw new Error(`Missive draft create error: ${t}`);
    }
    const draft = await draftRes.json();
    console.log("Draft created:", draft.id);
    console.log("Draft details:", JSON.stringify(draft, null, 2));

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
};
