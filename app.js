// ===== STEP 1: PASTE YOUR GEMINI/GEMMA API KEY BELOW =====
// Get it free at https://aistudio.google.com -> "Get API key"
const API_KEY = CONFIG.API_KEY;
const GEMMA_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent?key=${API_KEY}`;

// ===== SHARED REQUEST CONFIG: same generationConfig/safetySettings for every call =====
function buildGemmaBody(contents, systemInstruction) {
    const body = {

        contents,

        generationConfig: {

            temperature: 0.2,

            topP: 0.8,

            topK: 20,

            maxOutputTokens: 2048,

            responseMimeType: "text/plain",

            // Gemma 4 has an internal "thinking" step before it answers. Left uncontrolled,
            // that thinking text (its restated rules/reasoning) can leak into the response.
            // "minimal" keeps it fast and stops the leakage we were seeing.
            thinkingConfig: {
                thinkingLevel: "minimal"
            }

        },

        safetySettings: [

            {
                category: "HARM_CATEGORY_HARASSMENT",
                threshold: "BLOCK_NONE"
            },
            {
                category: "HARM_CATEGORY_HATE_SPEECH",
                threshold: "BLOCK_NONE"
            },
            {
                category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                threshold: "BLOCK_NONE"
            },
            {
                category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                threshold: "BLOCK_NONE"
            }

        ]

    };

    if (systemInstruction) {
        body.system_instruction = { parts: [{ text: systemInstruction }] };
    }

    return body;
}

// ===== SHARED CALLER: fetch + response parsing, used by every Gemma call =====
async function callGemmaAPI(body) {
    try {

        const response = await fetch(GEMMA_URL, {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify(body)

        });

        const data = await response.json();

        console.log(data);

        if (data.error)
            return "Error : " + data.error.message;

        if (data.promptFeedback && data.promptFeedback.blockReason)
            return "Blocked by safety filter: " + data.promptFeedback.blockReason;

        const candidate = data.candidates && data.candidates[0];

        if (!candidate)
            return "No response from model (empty candidates array).";

        if (candidate.finishReason && candidate.finishReason !== "STOP")
            console.warn("Non-normal finish reason:", candidate.finishReason, data.usageMetadata);

        const textParts = (candidate.content && candidate.content.parts || [])
            .filter(p => p.text && !p.thought)
            .map(p => p.text)
            .join("");

        if (!textParts)
            return `Model returned no text (finishReason: ${candidate.finishReason || "unknown"}). Try shortening the input or check the console for details.`;

        return textParts;

    }

    catch(err){

        return err.message;

    }
}

// ===== CORE FUNCTION: single-turn calls (analyzer, drafts, estimator) =====
// systemInstruction: persona/rules for the model, kept OUT of the user turn so it
// doesn't get echoed back. mimeType: pass the real uploaded file's type, not a hardcoded guess.
async function askGemma(promptText, imageBase64 = null, mimeType = "image/jpeg", systemInstruction = null) {

    const parts = [{ text: promptText }];

    if (imageBase64) {
        parts.push({
            inline_data: {
                mime_type: mimeType,
                data: imageBase64
            }
        });
    }

    const body = buildGemmaBody([{ role: "user", parts }], systemInstruction);

    return callGemmaAPI(body);
}

// ===== MULTI-TURN CHAT FUNCTION: used by the conversational assistant widget =====
// history: array of { role: "user" | "model", text: "..." }, oldest first, ending with
// the current user turn. Sending real multi-turn "contents" (rather than flattening into
// one prompt string) is what lets the bot actually remember the conversation.
async function askGemmaChat(history, systemInstruction) {
    const contents = history.map(turn => ({
        role: turn.role,
        parts: [{ text: turn.text }]
    }));

    const body = buildGemmaBody(contents, systemInstruction);

    return callGemmaAPI(body);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ===== HELPER: show a result with the "reviewed" stamp (matches style.css) =====
function showResult(el, text) {
  el.textContent = text;
  el.classList.toggle("has-content", Boolean(text && text.trim()));
}

// ===== SHARED: escape + lightweight markdown-ish -> HTML renderer =====
// The model is asked for "## Heading" section titles, "- bullet" points, and
// "**term**" bolding. This turns that into real <h4>/<ul><li>/<strong> markup
// instead of dumping literal "###" and "**" characters onto the page.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inlineFormat(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function renderStructuredText(raw) {
  const lines = raw.split(/\r?\n/);
  let html = "";
  let inList = false;

  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };

  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;

    // "## Heading", "### 1. Heading", or a lone "**Heading**" line
    const headingMatch = trimmed.match(/^#{1,4}\s*\d*\.?\s*(.+)/);
    const boldHeadingMatch = trimmed.match(/^\*\*(.+?)\*\*:?$/);
    if (headingMatch || boldHeadingMatch) {
      closeList();
      const headingText = (headingMatch ? headingMatch[1] : boldHeadingMatch[1]).replace(/\*\*/g, "").replace(/^\d+\.\s*/, "");
      html += `<h4>${escapeHtml(headingText)}</h4>`;
      return;
    }

    // "- point", "* point", "• point"
    const bulletMatch = trimmed.match(/^[-*•]\s+(.+)/);
    if (bulletMatch) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inlineFormat(bulletMatch[1])}</li>`;
      return;
    }

    closeList();
    html += `<p>${inlineFormat(trimmed)}</p>`;
  });

  closeList();
  return html;
}

// ===== TAB SWITCHING =====
function switchTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
  document.querySelector(`.tab-btn[data-tab="${tabId}"]`).classList.add("active");
  document.getElementById(tabId).classList.add("active");
}

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// ===== FEATURE 1: DOCUMENT ANALYZER (+ OCR via image) =====
const docFile = document.getElementById("docFile");
const docFileName = document.getElementById("docFileName");

docFile.addEventListener("change", () => {
  docFileName.textContent = docFile.files[0] ? docFile.files[0].name : "";
});

document.getElementById("analyzeBtn").addEventListener("click", async () => {
  const text = document.getElementById("docText").value.trim();
  const file = docFile.files[0];
  const resultBox = document.getElementById("analyzeResult");

  if (!text && !file) {
    showResult(resultBox, "Please paste some text or upload an image first.");
    return;
  }

  showResult(resultBox, "Analyzing…");

  let imageBase64 = null;
  let mimeType = "image/jpeg";
  if (file) {
    imageBase64 = await fileToBase64(file);
    mimeType = file.type || "image/jpeg";
  }

  const systemInstruction = `You are a precise Indian legal document analyst helping a citizen with no legal background. Base every point strictly on THIS document's actual content — names, amounts, dates, and clauses that really appear in it. Never include generic filler advice that isn't tied to something specific in the document. Do not show your reasoning or thinking process — output only the final structured explanation, nothing else.

Output using EXACTLY this structure: each section title on its own line starting with "## ", followed by 2 to 5 short bullet points, each starting with "- ". Inside a bullet, bold only the 2-4 word key term with **term**, and nothing else is bolded. Do not add any text before the first heading or after the last bullet. If a section genuinely doesn't apply to this document, write a single bullet saying so briefly instead of inventing content.

## What type of document this is
## Key clauses and obligations
## Risks you should know about
## Deadlines, penalties, and unfair terms`;

  const prompt = `Analyze this document and follow the required structure exactly.
Document text (if any): ${text || "See attached image"}`;

  const reply = await askGemma(prompt, imageBase64, mimeType, systemInstruction);
  resultBox.innerHTML = renderStructuredText(reply);
  resultBox.classList.add("has-content");
});

// ===== SHARED VOICE INPUT: mic buttons on every textbox =====
// One global language setting (persisted) drives every field-level mic button, so the
// user doesn't have to configure language separately per field. The standalone "Voice
// Assistant" tab was removed in favor of the chat assistant's own voice mode; this
// utility is what powers "speak instead of type" on ordinary form fields.

const FIELD_VOICE_LANG_KEY = "astraeaFieldVoiceLang";
const fieldVoiceLangSelect = document.getElementById("fieldVoiceLangSelect");

function loadFieldVoiceLang() {
  const saved = localStorage.getItem(FIELD_VOICE_LANG_KEY);
  if (saved) fieldVoiceLangSelect.value = saved;
}

fieldVoiceLangSelect.addEventListener("change", () => {
  localStorage.setItem(FIELD_VOICE_LANG_KEY, fieldVoiceLangSelect.value);
});

loadFieldVoiceLang();

// Best-effort conversion of a spoken amount into digits — handles plain digits Chrome
// already recognizes ("5000"), and common English number words including Indian scale
// words (hundred/thousand/lakh/crore), e.g. "two lakh fifty thousand" -> "250000".
function parseSpokenNumber(text) {
  const digitMatch = text.replace(/,/g, "").match(/\d+(\.\d+)?/);
  if (digitMatch) return digitMatch[0];

  const small = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90
  };
  const scale = { hundred: 100, thousand: 1000, lakh: 100000, lac: 100000, million: 1000000, crore: 10000000 };

  const words = text.toLowerCase().trim().split(/\s+/);
  let total = 0, current = 0, matched = false;

  for (const w of words) {
    if (Object.prototype.hasOwnProperty.call(small, w)) {
      current += small[w];
      matched = true;
    } else if (Object.prototype.hasOwnProperty.call(scale, w)) {
      matched = true;
      if (w === "hundred") {
        current = (current || 1) * 100;
      } else {
        total += (current || 1) * scale[w];
        current = 0;
      }
    }
  }
  total += current;
  return matched ? String(total) : null;
}

// Wires a mic button to fill (or append to) a target field using the shared language
// setting. options.numeric = true parses the speech into digits (for amount fields).
function attachVoiceInput(button, targetEl, options = {}) {
  let recognition = null;

  button.addEventListener("click", () => {
    if (recognition) {
      recognition.stop();
      return;
    }

    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) {
      alert("Voice input isn't supported in this browser. Try Chrome, or type instead.");
      return;
    }

    recognition = new SpeechRecognitionAPI();
    recognition.lang = fieldVoiceLangSelect.value;
    recognition.start();
    button.classList.add("listening");

    recognition.onresult = (event) => {
      const spokenText = event.results[0][0].transcript;

      if (options.numeric) {
        const parsed = parseSpokenNumber(spokenText);
        targetEl.value = parsed !== null ? parsed : spokenText;
      } else {
        targetEl.value = targetEl.value.trim()
          ? `${targetEl.value.trim()} ${spokenText}`
          : spokenText;
      }
      targetEl.dispatchEvent(new Event("input"));
      targetEl.focus();
    };

    recognition.onerror = (e) => {
      console.warn("Field mic error:", e.error);
    };

    recognition.onend = () => {
      button.classList.remove("listening");
      recognition = null;
    };
  });
}

attachVoiceInput(document.getElementById("docTextMic"), document.getElementById("docText"));
attachVoiceInput(document.getElementById("complaintInputMic"), document.getElementById("complaintInput"));
attachVoiceInput(document.getElementById("compDetailsMic"), document.getElementById("compDetails"));
attachVoiceInput(document.getElementById("compAmountMic"), document.getElementById("compAmount"), { numeric: true });
attachVoiceInput(document.getElementById("lawQueryMic"), document.getElementById("lawQuery"));


// ===== FEATURE 3: PROFESSIONAL LEGAL DRAFT GENERATOR =====

// ===== BRIDGE: Complaint Generator <-> Compensation Estimator =====
// Only complaint categories with a sensible compensation angle get a bridge — a Missing
// Person Report or Cyber Crime FIR doesn't map to a "compensation estimate" naturally.
const COMPLAINT_TO_COMP_TYPE = {
  "Personal Injury Complaint": "accident",
  "Motor Accident Claim": "motor_accident",
  "Medical Negligence Complaint": "medical_negligence",
  "Wrongful Termination Complaint": "termination",
  "Insurance Claim Complaint": "insurance",
  "Consumer Complaint": "consumer",
  "Defective Product Complaint": "consumer",
  "Refund Complaint": "consumer",
  "Service Deficiency Complaint": "consumer",
  "Ecommerce Complaint": "consumer",
  "Property Damage Complaint": "property",
  "Cheque Bounce Notice": "cheque_bounce",
  "Money Recovery Notice": "cheque_bounce",
  "Breach of Contract Notice": "contract_breach",
  "Legal Notice": "contract_breach"
};

// Drafts the official complaint/notice from whatever is currently in #complaintInput and
// #complaintType, and renders it into #complaintResult. Shared by the "Generate Official
// Draft" button AND the chat assistant, so both paths produce the exact same document.
async function generateComplaintDraft() {

    const incident = document.getElementById("complaintInput").value.trim();
    const complaintType = document.getElementById("complaintType").value;
    const resultBox = document.getElementById("complaintResult");
    const toCompBridge = document.getElementById("toCompBridge");

    toCompBridge.classList.remove("visible");

    if (!incident) {
        showResult(resultBox, "Please describe your issue first.");
        return;
    }

    showResult(resultBox, "Preparing official legal draft...");

  const systemInstruction = "You are an Indian legal drafting engine. Output ONLY the final application document — no explanation, no reasoning, no markdown, no placeholders.";

  const prompt = `Use this exact format:

FROM
Name : _____________________
Address : _____________________
Phone : _____________________
Email : _____________________
Date : _____________________

TO
The Station House Officer
________________ Police Station
________________ District

Subject :
Complaint regarding ${complaintType}

Respected Sir/Madam,

I respectfully submit the following for your kind consideration.

FACTS OF THE INCIDENT

Write the incident here in proper legal language using complete paragraphs.

PRAYER

Therefore I respectfully request you to kindly take necessary legal action in accordance with law and register my complaint.

ENCLOSURES
1.
2.
3.

Yours faithfully,

(Signature)
____________________
Name

Draft the application using this incident:

${incident}`;

  let reply = await askGemma(prompt, null, "image/jpeg", systemInstruction);

    resultBox.innerHTML = `
<div class="legal-document">
${reply.replace(/\n/g,"<br>")}
</div>
`;
resultBox.classList.add("has-content");

const mappedCompType = COMPLAINT_TO_COMP_TYPE[complaintType];
if (mappedCompType) {
    toCompBridge.dataset.compType = mappedCompType;
    toCompBridge.dataset.details = incident;
    toCompBridge.classList.add("visible");
}

}

document.getElementById("complaintBtn").addEventListener("click", generateComplaintDraft);

document.getElementById("toCompBtn").addEventListener("click", () => {
  const bridge = document.getElementById("toCompBridge");
  document.getElementById("compType").value = bridge.dataset.compType || "accident";
  document.getElementById("compDetails").value = bridge.dataset.details || "";
  switchTab("compensation");
  document.getElementById("compAmount").focus();
});

// ===== FEATURE 4: COMPENSATION ESTIMATOR (rule-based + AI explanation) =====

// Rough heuristic multipliers per case type. These are NOT legal formulas —
// just a starting point for the "range" shown to the user, always framed as an estimate.
const COMP_MULTIPLIERS = {
  accident:            { mult: 2.5, label: "Accident / Personal Injury" },
  motor_accident:      { mult: 3.0, label: "Motor Vehicle Accident (MACT claim)" },
  medical_negligence:  { mult: 4.0, label: "Medical Negligence" },
  termination:         { mult: 3.0, label: "Wrongful Termination" },
  insurance:           { mult: 1.1, label: "Insurance Claim Delay" },
  consumer:            { mult: 1.5, label: "Defective Product / Consumer Dispute" },
  property:            { mult: 1.3, label: "Property Damage" },
  cheque_bounce:       { mult: 2.0, label: "Cheque Bounce (Section 138)" },
  contract_breach:     { mult: 1.8, label: "Breach of Contract" }
};

// Reverse of COMPLAINT_TO_COMP_TYPE — one complaint category per comp type, used for the bridge.
const COMP_TYPE_TO_COMPLAINT = {
  accident: "Personal Injury Complaint",
  motor_accident: "Motor Accident Claim",
  medical_negligence: "Medical Negligence Complaint",
  termination: "Wrongful Termination Complaint",
  insurance: "Insurance Claim Complaint",
  consumer: "Consumer Complaint",
  property: "Property Damage Complaint",
  cheque_bounce: "Cheque Bounce Notice",
  contract_breach: "Breach of Contract Notice"
};

document.getElementById("compBtn").addEventListener("click", async () => {
  const type = document.getElementById("compType").value;
  const amount = parseFloat(document.getElementById("compAmount").value) || 0;
  const details = document.getElementById("compDetails").value.trim();
  const resultBox = document.getElementById("compResult");
  const toComplaintBridge = document.getElementById("toComplaintBridge");

  toComplaintBridge.classList.remove("visible");

  if (amount <= 0) {
    showResult(resultBox, "Please enter a valid amount.");
    return;
  }

  const config = COMP_MULTIPLIERS[type] || COMP_MULTIPLIERS.accident;
  const estimate = amount * config.mult;

  const low = Math.round(estimate * 0.8).toLocaleString("en-IN");
  const high = Math.round(estimate * 1.2).toLocaleString("en-IN");

  showResult(resultBox, `Estimated range: ₹${low} - ₹${high}\n\nGenerating explanation…`);

  const systemInstruction = "You explain compensation estimates to an Indian citizen with no legal background. Write in plain conversational paragraphs only — no markdown, no asterisks, no headers, no tables, no bullet symbols. Keep it under 180 words. Always make clear this is a rough estimate, not legal advice.";

  const prompt = `Case type: ${config.label}
Base amount: ₹${amount}
What happened: ${details || "no further details given"}
Estimated range: ₹${low} - ₹${high}

Explain in simple terms why the estimate is in this range for this specific situation, referencing the details above where relevant.`;

  const explanation = await askGemma(prompt, null, "image/jpeg", systemInstruction);
  showResult(resultBox, `Estimated range: ₹${low} - ₹${high}\n\n${explanation}`);

  const mappedComplaintType = COMP_TYPE_TO_COMPLAINT[type];
  if (mappedComplaintType) {
    toComplaintBridge.dataset.complaintType = mappedComplaintType;
    toComplaintBridge.dataset.details = details || `${config.label} case. Base amount involved: ₹${amount}.`;
    toComplaintBridge.classList.add("visible");
  }
});

document.getElementById("toComplaintBtn").addEventListener("click", () => {
  const bridge = document.getElementById("toComplaintBridge");
  document.getElementById("complaintType").value = bridge.dataset.complaintType || "Legal Notice";
  document.getElementById("complaintInput").value = bridge.dataset.details || "";
  switchTab("complaint");
  document.getElementById("complaintInput").focus();
});

// ===== FEATURE 4B: BNS / BNSS SECTION FINDER (statute library lookup) =====
// Takes a plain-language description of a crime, legal issue, or right, and returns
// the matching sections of the Bharatiya Nyaya Sanhita, 2023 (BNS — replaced the IPC)
// and the Bharatiya Nagarik Suraksha Sanhita, 2023 (BNSS — replaced the CrPC).
// The model is asked for a strict repeating block format so it can be rendered as
// proper section cards; if it ever drifts from that format, we fall back to plain text
// rather than showing broken markup.

function parseLawBlocks(raw) {
  const blocks = raw.split(/\n\s*-{3,}\s*\n/).map(b => b.trim()).filter(Boolean);
  const items = [];

  blocks.forEach(block => {
    const get = (key) => {
      const m = block.match(new RegExp(key + "\\s*:\\s*(.+)"));
      return m ? m[1].trim() : "";
    };
    const act = get("ACT");
    const section = get("SECTION");
    const title = get("TITLE");
    const summaryMatch = block.match(/SUMMARY\s*:\s*([\s\S]*?)(?:\n\s*PUNISHMENT|$)/i);
    const summary = summaryMatch ? summaryMatch[1].trim() : "";
    const punishment = get("PUNISHMENT");

    if (act && section) items.push({ act, section, title, summary, punishment });
  });

  return items;
}

function renderLawResults(el, raw) {
  const items = parseLawBlocks(raw);

  if (!items.length) {
    // Fallback: still show something readable rather than nothing.
    el.innerHTML = renderStructuredText(raw);
    el.classList.add("has-content");
    return;
  }

  el.innerHTML = items.map(item => {
    const actUpper = (item.act || "").toUpperCase();
    const badgeClass = actUpper === "BNSS" ? "bnss" : "bns";
    return `
      <div class="law-card">
        <div class="law-card-head">
          <span class="law-act-badge ${badgeClass}">${escapeHtml(actUpper || "—")}</span>
          <span class="law-section-num">Section ${escapeHtml(item.section || "—")}</span>
        </div>
        ${item.title ? `<h4>${escapeHtml(item.title)}</h4>` : ""}
        ${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ""}
        ${item.punishment ? `<p class="law-punishment"><strong>Punishment / Procedure:</strong> ${escapeHtml(item.punishment)}</p>` : ""}
      </div>
    `;
  }).join("");

  el.classList.add("has-content");
}

document.getElementById("lawBtn").addEventListener("click", async () => {
  const query = document.getElementById("lawQuery").value.trim();
  const resultBox = document.getElementById("lawResult");

  if (!query) {
    showResult(resultBox, "Please describe the crime, legal issue, or right you'd like sections for.");
    return;
  }

  showResult(resultBox, "Searching the BNS & BNSS…");

  const systemInstruction = `You are a statute-reference library for Indian criminal law: the Bharatiya Nyaya Sanhita, 2023 (BNS — replaced the Indian Penal Code) and the Bharatiya Nagarik Suraksha Sanhita, 2023 (BNSS — replaced the CrPC). Given a plain-language description of a crime, legal issue, or right, return only the sections genuinely relevant to it. Do not show your reasoning or thinking process.

Output ONLY a series of blocks in exactly this format, separated by a line containing just three dashes (---), and nothing else before, between, or after them:
ACT: BNS or BNSS
SECTION: <section number, e.g. 103(1)>
TITLE: <short official section title>
SUMMARY: <1-2 plain sentences on what this section covers, relative to the query>
PUNISHMENT: <typical punishment in one short line for BNS sections, or the procedural effect for BNSS sections; write "Procedural provision" if there is no punishment>

List the 2 to 5 most relevant sections, ordered most relevant first, mixing in BNSS procedural sections (arrest, FIR, bail, etc.) where they genuinely apply alongside BNS offence sections.`;

  const prompt = `Find the relevant BNS and BNSS sections for the following: ${query}`;

  const reply = await askGemma(prompt, null, "image/jpeg", systemInstruction);
  renderLawResults(resultBox, reply);
});

// ===== FEATURE 5: CONVERSATIONAL CHAT ASSISTANT (floating widget) =====
// Lets the user talk to Astraea directly — by voice or text, in English by default
// or any supported Indian language — with chat history, TTS narration (mutable), and
// "action chips" that jump the user to the relevant tab (analyzer / complaint /
// compensation) when the bot thinks that section would help.

const CHAT_HISTORY_KEY = "astraeaChatHistory";
const CHAT_LANG_NAMES = {
  "en-IN": "English",
  "hi-IN": "Hindi",
  "bn-IN": "Bengali",
  "ta-IN": "Tamil",
  "mr-IN": "Marathi",
  "pa-IN": "Punjabi",
  "te-IN": "Telugu"
};

// Maps the tag the model is instructed to emit -> which tab to open + chip label.
const CHAT_ACTION_MAP = {
  analyzer:     { tab: "analyzer",     label: "→ Open Document Analyzer" },
  complaint:    { tab: "complaint",    label: "→ Open Complaint Generator" },
  compensation: { tab: "compensation", label: "→ Estimate Compensation" },
  lawlibrary:   { tab: "lawlibrary",   label: "→ Find BNS/BNSS Sections" }
};

const TAB_LABELS = {
  analyzer: "the Document Analyzer",
  complaint: "the Complaint Generator",
  compensation: "the Compensation Estimator",
  lawlibrary: "the BNS/BNSS Section Finder"
};

// Direct "take me there" navigation, handled locally (no API call needed) so it's
// instant whether typed or spoken. Requires an explicit nav verb + a page keyword,
// so it doesn't fire on "I want to file a complaint" (which should stay conversational
// and lead into drafting, not just jump to an empty tab).
function detectNavIntent(text) {
  const navVerb = /\b(go to|open|show me|take me to|navigate to|switch to|move to)\b/i;
  if (!navVerb.test(text)) return null;
  if (/document\s*analy|analyzer|scan(ner)?/i.test(text)) return "analyzer";
  if (/complaint\s*(generator|tab|page|section)|legal\s*draft\s*(tab|page)?/i.test(text)) return "complaint";
  if (/compensation|estimator/i.test(text)) return "compensation";
  if (/bns|bnss|section\s*finder|penal\s*code|ipc|crpc/i.test(text)) return "lawlibrary";
  return null;
}

// The exact <option value="..."> list from the Complaint Generator dropdown, so the
// chat assistant's category choice always lines up with a real option.
function getComplaintCategoryList() {
  return Array.from(document.getElementById("complaintType").options).map(o => o.value);
}

// Matches the (possibly imperfect) category name the model returns against a real
// dropdown value — exact match first, then a loose substring match, then a safe default.
function matchComplaintCategory(raw) {
  const options = getComplaintCategoryList();
  const needle = raw.trim().toLowerCase();
  const exact = options.find(v => v.toLowerCase() === needle);
  if (exact) return exact;
  const partial = options.find(v => v.toLowerCase().includes(needle) || needle.includes(v.toLowerCase()));
  return partial || "Legal Notice";
}

// { role: "user" | "model", text } — role names match the Gemini API's roles directly,
// so this array can be sent straight to askGemmaChat without conversion.
let chatHistory = [];
let chatMuted = false;
let chatRecognition = null;

const chatFab = document.getElementById("chatFab");
const chatPanel = document.getElementById("chatPanel");
const chatMessagesEl = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatLangSelect = document.getElementById("chatLang");
const chatMuteBtn = document.getElementById("chatMuteBtn");
const chatClearBtn = document.getElementById("chatClearBtn");
const chatCloseBtn = document.getElementById("chatCloseBtn");
const chatMicBtn = document.getElementById("chatMicBtn");
const chatListeningRow = document.getElementById("chatListeningRow");

function loadChatHistory() {
  try {
    const saved = localStorage.getItem(CHAT_HISTORY_KEY);
    chatHistory = saved ? JSON.parse(saved) : [];
  } catch (e) {
    chatHistory = [];
  }
}

function saveChatHistory() {
  try {
    localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(chatHistory));
  } catch (e) {
    console.warn("Could not save chat history:", e);
  }
}

// Strips whichever trailing directive the model appended — either [ACTION:xyz] (a
// suggestion chip) or [DRAFT_COMPLAINT:category] (an instruction to actually draft
// the complaint now) — and returns clean display/speech text plus the parsed directive.
function extractChatDirective(rawText) {
  const draftMatch = rawText.match(/\[DRAFT_COMPLAINT:\s*([^\]]+)\]\s*$/i);
  if (draftMatch) {
    return {
      cleanText: rawText.slice(0, draftMatch.index).trim(),
      action: null,
      draftCategory: draftMatch[1].trim()
    };
  }

  const actionMatch = rawText.match(/\[ACTION:(analyzer|complaint|compensation|lawlibrary|none)\]\s*$/i);
  if (actionMatch) {
    const action = actionMatch[1].toLowerCase();
    return {
      cleanText: rawText.slice(0, actionMatch.index).trim(),
      action: action === "none" ? null : action,
      draftCategory: null
    };
  }

  return { cleanText: rawText.trim(), action: null, draftCategory: null };
}

function renderChatMessages() {
  chatMessagesEl.innerHTML = "";

  if (chatHistory.length === 0) {
    const hint = document.createElement("div");
    hint.className = "chat-empty-hint";
    hint.textContent = "Type or tap the mic to ask about your legal issue — in English or your own language.";
    chatMessagesEl.appendChild(hint);
    return;
  }

  chatHistory.forEach(turn => {
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble " + (turn.role === "user" ? "chat-bubble-user" : "chat-bubble-bot");
    bubble.textContent = turn.text;

    if (turn.role === "model" && turn.action && CHAT_ACTION_MAP[turn.action]) {
      const chip = document.createElement("div");
      chip.className = "chat-action-chip";
      chip.textContent = CHAT_ACTION_MAP[turn.action].label;
      chip.addEventListener("click", () => goToTabFromChat(CHAT_ACTION_MAP[turn.action].tab));
      bubble.appendChild(chip);
    }

    chatMessagesEl.appendChild(bubble);
  });

  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function goToTabFromChat(tabId) {
  switchTab(tabId);
  const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
  if (btn) {
    btn.classList.remove("tab-pulse");
    // restart the animation even if it was just triggered
    void btn.offsetWidth;
    btn.classList.add("tab-pulse");
    setTimeout(() => btn.classList.remove("tab-pulse"), 4200);
  }
  closeChatPanel();
  document.getElementById("tabs").scrollIntoView({ behavior: "smooth", block: "start" });
}

function openChatPanel() {
  chatPanel.classList.add("open");
  chatPanel.setAttribute("aria-hidden", "false");
  chatFab.classList.add("open");
  chatInput.focus();
}

function closeChatPanel() {
  chatPanel.classList.remove("open");
  chatPanel.setAttribute("aria-hidden", "true");
  chatFab.classList.remove("open");
  if (speechSynthesis.speaking) speechSynthesis.cancel();
}

chatFab.addEventListener("click", openChatPanel);
chatCloseBtn.addEventListener("click", closeChatPanel);

chatClearBtn.addEventListener("click", () => {
  if (!chatHistory.length) return;
  const confirmed = confirm("Clear this conversation? This can't be undone.");
  if (!confirmed) return;
  chatHistory = [];
  saveChatHistory();
  renderChatMessages();
});

chatMuteBtn.addEventListener("click", () => {
  chatMuted = !chatMuted;
  chatMuteBtn.setAttribute("aria-pressed", String(chatMuted));
  chatMuteBtn.textContent = chatMuted ? "🔇" : "🔊";
  chatMuteBtn.title = chatMuted ? "Unmute voice replies" : "Mute voice replies";
  if (chatMuted && speechSynthesis.speaking) speechSynthesis.cancel();
});

function speakChatReply(text, lang) {
  if (chatMuted) return;
  if (!("speechSynthesis" in window)) return;
  if (speechSynthesis.speaking) speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  speechSynthesis.speak(utterance);
}

function addTypingBubble() {
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble-bot typing";
  bubble.id = "chatTypingBubble";
  bubble.textContent = "Thinking…";
  chatMessagesEl.appendChild(bubble);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function removeTypingBubble() {
  const bubble = document.getElementById("chatTypingBubble");
  if (bubble) bubble.remove();
}

async function sendChatMessage(userText) {
  const trimmed = userText.trim();
  if (!trimmed) return;

  const lang = chatLangSelect.value;
  const langName = CHAT_LANG_NAMES[lang] || "English";

  chatHistory.push({ role: "user", text: trimmed });
  saveChatHistory();
  renderChatMessages();

  // Direct "open X" / "take me to X" commands are handled instantly and locally —
  // no need to round-trip to the API just to move around the site.
  const navTarget = detectNavIntent(trimmed);
  if (navTarget) {
    const botText = `Sure, opening ${TAB_LABELS[navTarget]} for you.`;
    chatHistory.push({ role: "model", text: botText, action: navTarget });
    saveChatHistory();
    renderChatMessages();
    speakChatReply(botText, lang);
    goToTabFromChat(CHAT_ACTION_MAP[navTarget].tab);
    return;
  }

  addTypingBubble();

  const categoryList = getComplaintCategoryList().join(", ");

  const systemInstruction = `You are Astraea, a warm, conversational Indian legal assistant chatting with a citizen who may have no legal background.
Rules:
1) The user's chosen language is ${langName} (${lang}). Reply in that language, unless the user's message is clearly written or spoken in a different language — then reply in their language instead.
2) Keep replies short and conversational (2 to 5 sentences), easy to understand, suitable both for reading and for being read aloud.
3) Plain sentences only — no markdown, no asterisks, no headers, no bullet symbols, no numbered lists.
4) Do not show your reasoning or thinking process — output only the reply itself.
5) If the user wants help writing a complaint, FIR, or legal notice, help them by talking it through: ask short clarifying questions one or two at a time (what happened, when, where, who was involved, what outcome they want) until you have enough to draft it well. Do not draft anything yourself in the chat text — drafting happens through a special tag, described below.
6) Once — and only once — you have enough detail to draft a complete complaint, end your reply on its own new line with exactly: [DRAFT_COMPLAINT: <one exact category from this list>] — choose the single closest match from: ${categoryList}. Say something like "I have enough to draft this now" in your normal reply just before that line. Use this tag INSTEAD of an [ACTION:] tag, never both.
7) Otherwise, if a different part of the site would help (and drafting isn't yet ready), end your reply on its own new line with exactly one tag: [ACTION:analyzer] for uploading/analyzing a document or photo, [ACTION:complaint] for opening the Complaint Generator manually, [ACTION:compensation] for estimating compensation, [ACTION:lawlibrary] for looking up relevant BNS/BNSS sections for a crime or issue, or [ACTION:none] if nothing applies right now. Note: you (this chat) already handle spoken conversation directly, so there is no separate voice tab to send anyone to.
8) This is general information, not legal advice from a licensed advocate — make that clear if the user is about to take a serious legal step.`;

  // Send recent context only, to keep requests small — last 12 turns plus this one.
  const recentHistory = chatHistory.slice(-13);

  const rawReply = await askGemmaChat(recentHistory, systemInstruction);
  const { cleanText, action, draftCategory } = extractChatDirective(rawReply);

  removeTypingBubble();
  chatHistory.push({ role: "model", text: cleanText || rawReply, action });
  saveChatHistory();
  renderChatMessages();

  speakChatReply(cleanText || rawReply, lang);

  if (draftCategory) {
    // Give the spoken confirmation a moment to start before we switch tabs and
    // (as part of closing the panel) cancel any in-progress narration.
    setTimeout(() => triggerChatComplaintDraft(draftCategory), 900);
  }
}

// Called when the chat assistant decides it has enough detail to actually draft the
// complaint: fills in the same Complaint Generator fields a user would fill in by hand,
// runs the exact same drafting function the button uses, then takes the user there.
async function triggerChatComplaintDraft(draftCategory) {
  const matchedCategory = matchComplaintCategory(draftCategory);
  document.getElementById("complaintType").value = matchedCategory;

  // Build the incident narrative from the user's side of the conversation so far —
  // this is the same free-text description the manual Complaint Generator expects.
  const incidentNarrative = chatHistory
    .filter(turn => turn.role === "user")
    .map(turn => turn.text)
    .join("\n");
  document.getElementById("complaintInput").value = incidentNarrative;

  goToTabFromChat("complaint");
  await generateComplaintDraft();

  chatHistory.push({
    role: "model",
    text: "I've filled in and generated your draft on the Complaint Generator page — please review it carefully before printing or submitting.",
    action: "complaint"
  });
  saveChatHistory();
  renderChatMessages();
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value;
  chatInput.value = "";
  sendChatMessage(text);
});

// ----- Voice input inside the chat widget -----
chatMicBtn.addEventListener("click", () => {
  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognitionAPI) {
    alert("Voice input isn't supported in this browser. Try Chrome, or type your message instead.");
    return;
  }

  if (chatRecognition) {
    chatRecognition.stop();
    return;
  }

  chatRecognition = new SpeechRecognitionAPI();
  chatRecognition.lang = chatLangSelect.value;
  chatRecognition.start();

  chatMicBtn.classList.add("listening");
  chatListeningRow.hidden = false;

  chatRecognition.onresult = (event) => {
    const spokenText = event.results[0][0].transcript;
    sendChatMessage(spokenText);
  };

  chatRecognition.onerror = (e) => {
    console.warn("Chat mic error:", e.error);
  };

  chatRecognition.onend = () => {
    chatMicBtn.classList.remove("listening");
    chatListeningRow.hidden = true;
    chatRecognition = null;
  };
});

// ----- Init on page load -----
loadChatHistory();
renderChatMessages();
