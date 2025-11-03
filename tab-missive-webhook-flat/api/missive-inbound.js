// api/missive-inbound.js
// Framework: Vercel "Other" (Node 18+)

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

/** Simple HTML stripper */
function stripHtml(html = "") {
  return String(html || "").replace(/<[^>]*>/g, "");
}

/** Clamp big strings */
function clamp(text, max = 120000) {
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max) + "\n[...truncated for length...]";
}

/** Build "Name <email>" */
function senderLabel(m) {
  const name =
    m.from_field?.name ||
    m.creator?.name ||
    (m.creator?.email ? m.creator.email.split("@")[0] : "") ||
    "Unknown";
  const email = m.from_field?.address || m.creator?.email || "";
  return email ? `${name} <${email}>` : name;
}

/** Ensure paragraph spacing */
function addParagraphSpacing(html) {
  return String(html || "").replace(/<\/p>\s*<p>/g, "</p><p><br></p><p>");
}

/** Append Tab signature */
function appendSignature(html) {
  const sig = `<p><br></p><p>Raghvi</p><p>—</p><p>Tab Support</p><p><br></p><p>Tab.</p><p><a href="https://business.tab.travel/payments">business.tab.travel/payments</a></p><p><br></p><p>Tab Labs Ltd is a company registered in England and Wales. Registered number: 09339113. Registered office: 6th Floor, 1 London Wall, London, EC2Y 5EB, UK.</p>`;
  if (html.includes("Raghvi") && html.includes("Tab Support")) return html;
  return html + sig;
}

/** Fetch conversation messages */
async function fetchConversationMessages(conversationId) {
  const limit = 10;
  const MAX_PAGES = 6;
  let until;
  let collected = [];
  let pages = 0;

  while (pages < MAX_PAGES) {
    const url = new URL(`${MISSIVE_API}/conversations/${encodeURIComponent(conversationId)}/messages`);
    url.searchParams.set("limit", String(limit));
    if (until) url.searchParams.set("until", String(until));

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
        return j?.message || j?.messages || j;
      })
    );

    collected = collected.concat(full);
    const deliveredAts = page.map((p) => p.delivered_at).filter(Boolean);
    const oldestInPage = deliveredAts.length ? Math.min(...deliveredAts) : undefined;

    if (page.length < limit || !oldestInPage || oldestInPage === until) break;
    until = oldestInPage;
    pages += 1;
    await sleep(120);
  }

  collected.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return collected;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(200).send("ok");

    // === Parse payload ===
    const payload = req.body || {};
    const convoId = payload?.conversation?.id;
    if (!convoId) {
      return res.status(400).json({ error: "Missing conversation.id in Missive payload" });
    }

    // === Fetch conversation metadata ===
    const convoResp = await fetch(`${MISSIVE_API}/conversations/${encodeURIComponent(convoId)}`, {
      headers: { Authorization: `Bearer ${process.env.MISSIVE_API_TOKEN}` },
    });
    if (!convoResp.ok) {
      const t = await convoResp.text();
      throw new Error(`Missive conversation fetch failed: ${t}`);
    }
    const convo = await convoResp.json();
    const conversation = convo.conversations?.[0];
    const subject = (conversation?.subject || conversation?.latest_message_subject || "").trim();

    const messages = await fetchConversationMessages(convoId);
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

    // === Routing logic ===
    const WEBSITE_BASE = "https://business.tab.travel";
    const UTM_SUFFIX = "show=true&referrer_code=F25&utm_source=Missive&utm_medium=email&utm_campaign=F25";

    function joinUrl(path = "") {
      const base = WEBSITE_BASE.replace(/\/+$/, "");
      const cleanPath = String(path || "/").replace(/^\/*/, "/");
      return `${base}${cleanPath}`;
    }

    function withUtms(url) {
      return url.includes("?") ? `${url}&${UTM_SUFFIX}` : `${url}?${UTM_SUFFIX}`;
    }

    function fold(str = "") {
      return String(str).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }
    function haystack(text = "", subj = "") {
      const raw = `${subj}\n${text}`;
      return {
        lower: raw.toLowerCase(),
        foldLower: fold(raw).toLowerCase(),
      };
    }
    function testAny(hay, ...regexes) {
      return regexes.some((rx) => rx.test(hay.lower) || rx.test(hay.foldLower));
    }

    function detectCtaPath(text = "", subj = "") {
      const hay = haystack(text, subj);

      if (
        testAny(
          hay,
          /(in[-\s]?person|face\s?to\s?face|pos\b|card\s?(reader|machine)|tap\s?to\s?pay|pay\s?by\s?phone|in\s?store|on[-\s]?site)/i,
          /(en\s?persona|presencial|en\s?tienda|en\s?el\s?sitio|tpv|datafono|dat[aá]fono|lector\s?de\s?tarjetas|pagar\s?por\s?telefono|pago\s?por\s?telefono)/i,
          /(presencial|em\s?pessoa|na\s?loja|no\s?local|pos\b|maquininha|leitor\s?de\s?cart[aã]o|pagar\s?por\s?tele(?:pho|fo)ne)/i,
          /(en\s?personne|en\s?magasin|sur\s?place|tpe\b|lecteur\s?de\s?carte|paiement\s?par\s?tele(?:pho|fo)ne|sans\s?contact)/i
        )
      ) {
        return "/features/in-person";
      }

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

      if (
        testAny(
          hay,
          /(website|on\s?(your|my)\s?(website|site)|checkout|online\s?payments|payment\s?(form|page)|accept\s?payments\s?online)/i,
          /(sitio\s?web|en\s?(su|mi)\s?sitio|en\s?la\s?web|pagos?\s?(online|en\s?linea)|checkout|p[aá]gina\s?de\s?pago|formulario\s?de\s?pago|aceptar\s?pagos?\s?en\s?l[ií]nea)/i,
          /(site|website|no\s?(seu|meu)\s?site|pagamentos?\s?online|checkout|p[aá]gina\s?de\s?pagamento|formul[aá]rio\s?de\s?pagamento|aceitar\s?pagamentos?\s?online)/i,
          /(site\s?web|sur\s?(votre|mon)\s?site|en\s?ligne|paiements?\s?en\s?ligne|page\s?de\s?paiement|formulaire\s?de\s?paiement|accepter\s?les\s?paiements?\s?en\s?ligne)/i
        )
      ) {
        return "/features/on-your-website";
      }

      if (
        testAny(
          hay,
          /(payment\s?link|pay\s?link|link\s?to\s?pay|invoice|request\s?(a\s?)?payment|advance\s?payment|deposit\s?request)/i,
          /(enlace\s?de\s?pago|link\s?de\s?pago|enlace\s?para\s?pagar|factura|solicitud\s?de\s?pago|pago\s?por\s?adelantado|anticipo|dep[oó]sito)/i,
          /(link\s?de\s?pagamento|link\s?para\s?pagar|fatura|pedido\s?de\s?pagamento|pagamento\s?adiantado|adiantamento)/i,
          /(lien\s?de\s?paiement|lien\s?pour\s?payer|facture|demande\s?de\s?paiement|paiement\s?a\s?l[’']?avance|acompte)/i
        )
      ) {
        return "/features/in-advance";
      }

      return "/";
    }

    const suggestedPath = detectCtaPath(threadText, subject);
    const SUGGESTED_CTA_URL = withUtms(joinUrl(suggestedPath));

    // === Build request to OpenAI ===
    const requestBody = {
      model: process.env.OPENAI_MODEL || "gpt-5",
      input: `SYSTEM: respond to customer based on files. Thread:\n${threadText}`,
      tools: [
        {
          type: "file_search",
          vector_store_ids: [String(process.env.VECTOR_STORE_ID)],
          max_num_results: 10,
        },
      ],
      tool_choice: "auto",
    };

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
    const messageOutput = response.output?.find((i) => i.type === "message");
    const out = messageOutput?.content?.[0]?.text || "<p>Thanks for reaching out.</p>";

    // === Greeting + CTA ===
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

    const lastMsg = messages[messages.length - 1];
    const recipientFirst = firstNameFrom(lastMsg);
    const greetingHtml = `<p>Hi ${recipientFirst || "there"},</p>`;
    let finalHtml = /<\/?[a-z][\s\S]*>/i.test(out)
      ? out
      : `<p>${out.replace(/\n/g, "<br/>")}</p>`;
    if (!/^<p>\s*hi\b/i.test(finalHtml)) finalHtml = greetingHtml + finalHtml;
    const ctaSentence = `<p>You can find out more and apply on <a href="${SUGGESTED_CTA_URL}">our website</a> — we look forward to working with you!</p>`;
    if (!/business\.tab\.travel/i.test(finalHtml)) finalHtml += ctaSentence;
    finalHtml = addParagraphSpacing(finalHtml);

    // === Create draft ===
    const subjectOut = subject
      ? subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`
      : "Re:";

    const draftRes = await fetch(`${MISSIVE_API}/drafts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MISSIVE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        drafts: {
          conversation: convoId,
          subject: subjectOut,
          body: appendSignature(finalHtml),
          quote_previous_message: false,
          from_field: { address: "hello@tab.travel", name: "Raghvi" },
          to_fields: [
            {
              address: messages[messages.length - 1]?.from_field?.address,
              name: messages[messages.length - 1]?.from_field?.name,
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

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
};
