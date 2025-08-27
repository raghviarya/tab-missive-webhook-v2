// api/missive-inbound.js
// Framework: Vercel "Other" (Node 18+)
// This version uses OpenAI Assistants (file_search) to draft HTML replies using the FULL Missive thread.

const OPENAI_API = "https://api.openai.com/v1";
const MISSIVE_API = "https://api.missiveapp.com/v1";

// Helper: wait
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Optional: clamp huge threads
function clamp(text, max = 16000) {
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max) + "\n[...truncated for length...]";
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

    // 2) Fetch FULL thread from Missive
    // (Use conversations/:id because it returns messages inline on most accounts.
    // If your account uses a different shape, swap to /messages?search[conversation]=convoId.)
    const convoResp = await fetch(`${MISSIVE_API}/conversations/${encodeURIComponent(convoId)}`, {
      headers: { Authorization: `Bearer ${process.env.MISSIVE_API_TOKEN}` }
    });
    if (!convoResp.ok) {
      const t = await convoResp.text();
      throw new Error(`Missive conversation fetch failed: ${t}`);
    }
    const convo = await convoResp.json();

    // Build readable thread text (oldest → newest)
    const msgs = (convo.conversation?.messages || [])
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map(m => {
        const who = m.creator?.email || m.from_field?.address || "unknown";
        const when = m.created_at || "";
        const text = m.text || (m.body ? stripHtml(m.body) : "");
        return `From: ${who}\nDate: ${when}\n---\n${text}`;
      })
      .join("\n\n------------------------\n\n");

    const threadText = clamp(msgs, 32000); // generous cap for long convos
    const subject = (convo.conversation?.subject || "").trim();

    // 3) Create an OpenAI Thread with your prompt + full thread
    const systemHint = process.env.SYSTEM_HINT || "Reply in concise, professional HTML (<p>, <ul>, <li>). No signature.";
    const userMessage = [
      `Context:\n${systemHint}`,
      "",
      "Task: Draft an HTML reply to the customer using our knowledge files if relevant.",
      "Guidelines:",
      "- Be brief but complete; add bullet points for steps or missing info.",
      "- If policy/FAQ applies, incorporate it (no explicit citations).",
      "- Do NOT repeat the whole thread.",
      "",
      `Subject: ${subject || "(no subject)"}`,
      "",
      "=== FULL THREAD (oldest → newest) ===",
      threadText
    ].join("\n");

    // Create Thread
    const threadCreate = await fetch(`${OPENAI_API}/threads`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: userMessage }]
      })
    });
    if (!threadCreate.ok) {
      const t = await threadCreate.text();
      throw new Error(`OpenAI thread create error: ${t}`);
    }
    const thread = await threadCreate.json();

    // 4) Run the Assistant (which has file_search + your vector store)
    const runCreate = await fetch(`${OPENAI_API}/threads/${thread.id}/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        assistant_id: process.env.ASSISTANT_ID,
        // Optional: override model at run time
        model: process.env.OPENAI_MODEL || undefined
      })
    });
    if (!runCreate.ok) {
      const t = await runCreate.text();
      throw new Error(`OpenAI run create error: ${t}`);
    }
    const run = await runCreate.json();

    // 5) Poll run status (simple polling; you can replace with webhooks later)
    let status = run.status;
    let tries = 0;
    while ((status === "queued" || status === "in_progress") && tries < 60) {
      await sleep(1200);
      const r = await fetch(`${OPENAI_API}/threads/${thread.id}/runs/${run.id}`, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
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
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    });
    if (!msgsResp.ok) {
      const t = await msgsResp.text();
      throw new Error(`OpenAI messages fetch error: ${t}`);
    }
    const threadMsgs = await msgsResp.json();
    const assistantMsg = threadMsgs.data.find(m => m.role === "assistant");
    const out = assistantMsg?.content?.map(c => c.text?.value || "").join("\n").trim() || "<p>Thanks for reaching out.</p>";

    // Ensure HTML (Assistants return plain text; convert newlines)
    const bodyHtml = /<\/?[a-z][\s\S]*>/i.test(out) ? out : `<p>${out.replace(/\n/g, "<br/>")}</p>`;

    // 7) Create a draft reply in the same Missive conversation
    const draftResp = await fetch(`${MISSIVE_API}/drafts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MISSIVE_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        drafts: {
          conversation: convoId,
          subject: subject ? `Re: ${subject}` : "Re:",
          body: bodyHtml,
          quote_previous_message: false
        }
      })
    });
    if (!draftResp.ok) {
      const t = await draftResp.text();
      throw new Error(`Missive draft create error: ${t}`);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
};

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
