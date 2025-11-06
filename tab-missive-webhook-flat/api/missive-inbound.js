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
  const sig = `<p><br></p><p>Raghvi</p><p>—</p><p>Tab Support</p><p><br></p><p>Tab.</p><p><a href="https://business.tab.travel/payments">business.tab.travel/payments</a></p><p><br></p><p>Tab Labs Ltd is a company registered in England and Wales. Registered number: 09339113. Registered office: 6th Floor, 1 London Wall, London, EC2Y 5EB, UK.</p>`;
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
  const MAX_PAGES = 6; // Cap total (6 * 10 = 60 messages)
  let until = undefined; // pagination cursor (oldest delivered_at from previous page)
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
        // Single message object may be returned as { message: {...} } or { messages: {...} }
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

  // Present oldest→newest for the model
  collected.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return collected;
}

/* =========================
   NEW small helpers (greeting target & structure)
   ========================= */

/** Does an address belong to Tab? */
function isFromTabAddress(addr = "") {
  const a = String(addr).toLowerCase().trim();
  return a.endsWith("@tab.travel") || a === "hello@tab.travel";
}

/** Is a message from Tab (internal)? */
function isFromTab(m = {}) {
  const addr = m?.from_field?.address || m?.creator?.email || "";
  return isFromTabAddress(addr);
}

/** Latest message from the external sender (not Tab). */
function getReplyTarget(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isFromTab(m)) return m;
  }
  // Fallback: last message if all internal
  return messages[messages.length - 1];
}

/** Extract first name for greeting. */
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

/** Strip to plain text (rough). */
function stripToPlainText(html = "") {
  return String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** Detect if reply already starts with a greeting. */
function startsWithGreeting(html = "") {
  const text = stripToPlainText(html).toLowerCase();
  return /^(hi|hello|dear)\b/.test(text);
}

/** Personalise "Hi there," to "Hi Name," if we have a name. */
function personalizeExistingGreeting(html = "", name = "") {
  if (!name) return html;
  return html
    .replace(/(<p>)(\s*hi\s+there\s*,?\s*)(<\/p>)/i, `$1Hi ${name},$3`)
    .replace(/^(\s*)hi\s+there\s*,?/i, `Hi ${name},`);
}

/** If duplicate greetings occur back-to-back, keep the first. */
function dedupeGreetings(html = "") {
  return html.replace(
    /(<p>\s*(?:hi|hello|dear)[^<]*<\/p>)\s*(<p>\s*(?:hi|hello|dear)[^<]*<\/p>)/i,
    "$1"
  );
}

/** Ensure multi-paragraph structure and basic bullets if needed. */
function ensureReadableStructure(html = "") {
  const hasList = /<(ul|ol)\b/i.test(html);
  const pCount = (html.match(/<p\b/gi) || []).length;

  // Convert simple "- " or "• " lines to <ul><li>…</li></ul> if no list exists
  const plain = stripHtml(html);
  const dashListRegex = /(^|\n|\r)(?:-|\u2022)\s+\S+/m;
  if (!hasList && dashListRegex.test(plain)) {
    const lines = plain.split(/\s*[\r\n]+\s*/);
    const items = lines
      .filter((l) => /^(-|\u2022)\s+/.test(l))
      .map((l) => l.replace(/^(-|\u2022)\s+/, "").trim());
    if (items.length >= 2) {
      const ul = `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
      html += ul;
    }
  }

  // If it's effectively one paragraph, split into short <p> chunks
  if (pCount <= 1) {
    const sentences = plain.split(/(?<=[.!?])\s+(?=[A-Z])/);
    if (sentences.length > 2) {
      const chunks = [];
      let buf = [];
      sentences.forEach((s) => {
        buf.push(s);
        if (buf.length >= 2) {
          chunks.push(buf.join(" "));
          buf = [];
        }
      });
      if (buf.length) chunks.push(buf.join(" "));
      html = chunks.map((c) => `<p>${c}</p>`).join("");
    }
  }

  return html;
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

    /* === NEW: CTA routing (single scheme), UTM F25 === */
    const WEBSITE_BASE = "https://business.tab.travel";
    const UTM_SUFFIX =
      "show=true&referrer_code=F25&utm_source=Missive&utm_medium=email&utm_campaign=F25";

    const joinUrl = (path = "/") =>
      `${WEBSITE_BASE.replace(/\/+$/, "")}${String(path || "/").replace(/^\/*/, "/")}`;

    const withUtms = (url) => (url.includes("?") ? `${url}&${UTM_SUFFIX}` : `${url}?${UTM_SUFFIX}`);

    const fold = (s = "") => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const haystack = (text = "", subj = "") => {
      const raw = `${subj}\n${text}`;
      return { lower: raw.toLowerCase(), foldLower: fold(raw).toLowerCase() };
    };
    const testAny = (hay, ...regexes) =>
      regexes.some((rx) => rx.test(hay.lower) || rx.test(hay.foldLower));

    function detectCtaPath(text = "", subj = "") {
      const hay = haystack(text, subj);

      // In-person payments
      if (
        testAny(
          hay,
          /(in[-\s]?person|face\s?to\s?face|pos\b|card\s?(reader|machine)|tap\s?to\s?pay|pay\s?by\s?phone|in\s?store|on[-\s]?site)/i,
          /(en\s?persona|presencial|en\s?tienda|tpv|dat[aá]fono|lector\s?de\s?tarjetas|pago\s?por\s?tel[eé]fono)/i,
          /(em\s?pessoa|na\s?loja|pos\b|maquininha|leitor\s?de\s?cart[aã]o|pagar\s?por\s?telef[oô]ne)/i,
          /(en\s?personne|en\s?magasin|sur\s?place|tpe\b|lecteur\s?de\s?carte|paiement\s?par\s?t[eé]l[eé]phone)/i
        )
      ) {
        return "/features/in-person";
      }

      // Integrations (external platforms)
      if (
        testAny(
          hay,
          /(integration|integrations|integrate|plugin|plug[-\s]?in|connect\s?with|works\s?with|supports|pms|booking\.com|airbnb|xero|quickbooks)/i,
          /(integraci[oó]n|integraciones|integrar|plugin|conector|conectar\s?con|funciona\s?con|pms|booking\.com|airbnb|xero|quickbooks)/i,
          /(integra[cç][aã]o|integra[cç][oõ]es|integrar|plugin|conectar\s?com|funciona\s?com|pms|booking\.com|airbnb|xero|quickbooks)/i,
          /(int[eé]gration|int[eé]grations|int[eé]grer|plugin|se\s?connecter\s?[aà]|fonctionne\s?avec|pms|booking\.com|airbnb|xero|quickbooks)/i
        )
      ) {
        return "/features/integrations";
      }

      // Accepting payments on website
      if (
        testAny(
          hay,
          /(website|on\s?(your|my)\s?(website|site)|checkout|online\s?payments|payment\s?(form|page)|accept\s?payments\s?online)/i,
          /(sitio\s?web|en\s?(su|mi)\s?sitio|pagos?\s?(online|en\s?l[ií]nea)|p[aá]gina\s?de\s?pago|formulario\s?de\s?pago)/i,
          /(site|no\s?(seu|meu)\s?site|pagamentos?\s?online|p[aá]gina\s?de\s?pagamento|formul[aá]rio)/i,
          /(site\s?web|sur\s?(votre|mon)\s?site|paiements?\s?en\s?ligne|page\s?de\s?paiement|formulaire)/i
        )
      ) {
        return "/features/on-your-website";
      }

      // Payment links / invoices / advance payments
      if (
        testAny(
          hay,
          /(payment\s?link|pay\s?link|link\s?to\s?pay|invoice|request\s?(a\s?)?payment|advance\s?payment|deposit\s?request)/i,
          /(enlace\s?de\s?pago|link\s?de\s?pago|factura|solicitud\s?de\s?pago|pago\s?por\s?adelantado|anticipo|dep[oó]sito)/i,
          /(link\s?de\s?pagamento|fatura|pedido\s?de\s?pagamento|pagamento\s?adiantado|adiantamento)/i,
          /(lien\s?de\s?paiement|facture|demande\s?de\s?paiement|paiement\s?a\s?l[’']?avance|acompte)/i
        )
      ) {
        return "/features/in-advance";
      }

      // Default to main site
      return "/";
    }

    const suggestedPath = detectCtaPath(threadText, subject);
    const SUGGESTED_CTA_URL = withUtms(joinUrl(suggestedPath));

    // === Prompt: refined rules + CTA logic (kept order & policy, augmented) ===
    const FALLBACK_OVERVIEW = `
If the user asks for "more information" or a general overview (e.g., "send more info", "tell me more"):
- Provide a concise overview in HTML:
  <p>1–2 sentence intro</p>
  <ul>
    <li>What it is (plain language)</li>
    <li>Core benefits (2–4 bullets)</li>
    <li>What the user can do next (1–2 bullets)</li>
  </ul>
- Close with a friendly line that links inline: "You can find out more and apply on <a href="${SUGGESTED_CTA_URL}">our website</a> — we look forward to working with you!"
`.trim();

    const systemHint = process.env.SYSTEM_HINT || [
      "You are Tab's email drafting assistant for both customer service and outbound cold emails.",
      "Use <p> for every paragraph. Keep each paragraph to 2–4 sentences max. The system will automatically add proper spacing between paragraphs.",
      "Tone: professional, empathetic, concise, polished, and sales-driven. Prefer 2–4 short paragraphs; use lists for steps.",
      "Do not overpromise. Do not set up accounts or complete tasks for the user; provide guidance and next steps.",
      "Adapt formality to the sender's tone. For complaints: acknowledge, take responsibility where appropriate, give a clear plan to resolve.",
      'IMPORTANT: You have access to file_search which will automatically search your knowledge base files. Use this information to provide accurate responses.',
      'PRIORITY ORDER: 1) ALWAYS check "Canned responses.pdf" FIRST - if there is a relevant canned response, use it exactly as written. 2) Only if no suitable canned response exists, then consult "Fin context.pdf" and synthesize an answer.',
      'When using canned responses, adapt them slightly to the specific customer situation but keep the core message and structure.',
      "Use file_search to ground facts; do not show citations, filenames, or IDs to the customer.",
      "FIRST, ALWAYS check for these classifications before drafting any reply:",
      '- Automated/irrelevant bulk emails: output ONLY "Automated response" (nothing else)',
      '- Spam/phishing attempts: output ONLY "spam" (nothing else)',
      '- Unsubscribe/angry/remove requests: output ONLY "Unsubscribe" (nothing else)',
      '- Explicit WhatsApp handoff requests with phone number: output ONLY "Whatsapp" (nothing else)',
      "ONLY if none of these classifications apply, then proceed to draft a helpful reply.",
      'Only output "I don\'t know" for a specific fact/policy that is truly unknown; not for generic "more info" asks.',
      // NEW structure & CTA guidance
      "Structure: Start with a greeting paragraph, then 1–2 short paragraphs, use a bulleted list for steps/options when relevant, then a closing sentence with the inline ‘our website’ link. Avoid a single-paragraph reply.",
      "Start with a short greeting (e.g., 'Hi <first name>,' or 'Hi there,').",
      `Close with a friendly, integrated line that links inline: “You can find out more and apply on <a href=\\"${SUGGESTED_CTA_URL}\\">our website</a> — we look forward to working with you!” (do not place a standalone 'Apply now' line).`,
      "Link routing policy: default to https://business.tab.travel/ with UTM F25. If the message is about: in-person payments ➜ /features/in-person; integrations (external platforms) ➜ /features/integrations; accepting payments on website ➜ /features/on-your-website; payment links or invoices ➜ /features/in-advance. Use the provided SUGGESTED_CTA_URL.",
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
      "CTA POLICY:",
      `- Use the integrated sentence with inline link to: ${SUGGESTED_CTA_URL}`,
      "- Do not add a standalone 'Apply now' line.",
      "",
      "CONTEXT (FULL THREAD, oldest → newest):",
      threadText,
    ].join("\n");

    // === Responses API with file_search (preserved) ===
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

    // === Greeting + integrated CTA + structure enforcement ===
    const replyTarget = getReplyTarget(messages);
    const recipientFirst = firstNameFrom(replyTarget);
    const ourGreeting = `<p>Hi ${recipientFirst || "there"},</p>`;

    let finalHtml = /<\/?[a-z][\s\S]*>/i.test(out) ? out : `<p>${out.replace(/\n/g, "<br/>")}</p>`;

    if (startsWithGreeting(finalHtml)) {
      finalHtml = personalizeExistingGreeting(finalHtml, recipientFirst);
    } else {
      finalHtml = ourGreeting + finalHtml;
    }
    finalHtml = dedupeGreetings(finalHtml);

    const ctaSentence = `<p>You can find out more and apply on <a href="${SUGGESTED_CTA_URL}">our website</a> — we look forward to working with you!</p>`;
    if (!/business\.tab\.travel/i.test(finalHtml)) {
      finalHtml += ctaSentence;
    }

    // Ensure readable multi-paragraph structure and bullets when appropriate
    finalHtml = ensureReadableStructure(finalHtml);

    // Enforce Missive spacing
    finalHtml = addParagraphSpacing(finalHtml);

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
          from_field: { address: "hello@tab.travel", name: "Raghvi" },
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
