// Sattva Path Collective — client-side JS
// Events + emotions now come from the API (/api/*). Site content sections,
// custom sections, gallery, and the local admin CMS still use localStorage.

// ---------------------- API helpers ----------------------

async function apiSend(method, path, body, extraHeaders = {}) {
  const opts = {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...extraHeaders }
  };
  if (body != null) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg;
    try { msg = (await res.json()).error; } catch { msg = res.statusText; }
    const err = new Error(msg || "request_failed");
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}
const apiGet    = (p, h)          => apiSend("GET",    p, null, h);
const apiPost   = (p, body, h)    => apiSend("POST",   p, body, h);
const apiPatch  = (p, body, h)    => apiSend("PATCH",  p, body, h);
const apiDelete = (p, h)          => apiSend("DELETE", p, null, h);

function getClientId() {
  let id = localStorage.getItem("sattva-client-id");
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem("sattva-client-id", id);
  }
  return id;
}
const CLIENT_ID = getClientId();
const CLIENT_HEADER = { "X-Client-Id": CLIENT_ID };

// ---------------------- Assistant answers (unchanged, still static) ----------------------

const answers = [
  {
    match: ["what", "space", "sattva", "collective", "about"],
    answer:
      "Sattva Path Collective is a calming space for spiritual guidance, meditation, and retreats. The approach is gentle: begin where you are and bring spirituality into real daily life."
  },
  {
    match: ["retreat", "when", "date", "where", "location"],
    answer:
      "The Sattva Path Retreat is September 19-20, 2026 at Enchanted Hills Retreat, 3568 Mt Veeder Rd, Napa, CA 94558. It is organized by Sattva Path Collective LLC and is for adults 18 years or older. For direct questions, email Sattvapathcollective@gmail.com."
  },
  {
    match: ["register", "registration", "sign", "join"],
    answer:
      "You can register for the retreat through the Sattva Path registration page on this site. Use the Register link in the navigation or retreat section."
  },
  {
    match: ["meditation", "experience", "beginner", "new"],
    answer:
      "Prior meditation experience is not required. The guidance is gentle and supports simple meditation practices that can fit into everyday life."
  },
  {
    match: ["guidance", "spiritual", "help"],
    answer:
      "Spiritual guidance here is not about leaving your life behind. It is support for finding peace, clarity, acceptance, and trust while living fully in the world."
  },
  {
    match: ["age", "adult", "18"],
    answer:
      "The retreat is only for individuals 18 years or older."
  },
  {
    match: ["contact", "question", "inquire", "email"],
    answer:
      "For direct questions, email Sattvapathcollective@gmail.com. The upcoming retreat location is Enchanted Hills Retreat, 3568 Mt Veeder Rd, Napa, CA 94558. You can also use the registration form to begin a conversation."
  }
];

// ---------------------- DOM handles ----------------------

const messages = document.querySelector("#assistantMessages");
const form = document.querySelector("#assistantForm");
const input = document.querySelector("#assistantInput");
const dynamicEvents = document.querySelector("#dynamicEvents");
const customSectionGrid = document.querySelector("#customSectionGrid");
const customSections = document.querySelector("#customSections");
const siteGallery = document.querySelector("#siteGallery");
const photoFilters = document.querySelector("#photoFilters");
const emotionForm = document.querySelector("#emotionForm");
const emotionList = document.querySelector("#emotionList");
const hostResponsePreference = document.querySelector("#hostResponsePreference");
const communityResponsePreference = document.querySelector("#communityResponsePreference");
const emotionEmailWrap = document.querySelector("#emotionEmailWrap");
const emotionEmail = document.querySelector("#emotionEmail");
const heartStatus = document.querySelector("#heartStatus");
const speechStatus = document.querySelector("#speechStatus");
let activePhotoCategory = "All";
let activeRecognition = null;

// ---------------------- basic helpers ----------------------

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function addMessage(text, type = "") {
  if (!messages) return;
  const bubble = document.createElement("div");
  bubble.className = type ? `message ${type}` : "message";
  bubble.textContent = text;
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
}

function answerQuestion(question) {
  const normalized = question.toLowerCase();
  const found = answers.find((item) => item.match.some((word) => normalized.includes(word)));
  return found
    ? found.answer
    : "I can answer basic questions about guidance, meditation, the retreat, registration, and contact. For personal spiritual guidance or specific retreat questions, please email Sattvapathcollective@gmail.com. The retreat location is Enchanted Hills Retreat, 3568 Mt Veeder Rd, Napa, CA 94558.";
}

function askAssistant(question) {
  const clean = question.trim();
  if (!clean) return;
  addMessage(clean, "user");
  addMessage(answerQuestion(clean));
}

function showHeartStatus(message, type = "success") {
  if (!heartStatus) return;
  heartStatus.textContent = message;
  heartStatus.className = `form-status ${type}`;
  heartStatus.hidden = false;
}

function getJson(key, fallback = []) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch { return fallback; }
}

function setJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

function heartPostWarning(text) {
  const clean = String(text || "").toLowerCase();
  const phoneLike = clean.replace(/\D/g, "").length >= 7;
  const asksForPhone = /\b(phone|number|call|text|contact|mobile)\b/.test(clean);
  const asksOnlyForPhone = /\b(what|share|send|give|provide|need|want|asking|ask)\b.*\b(phone|number|mobile)\b/.test(clean);
  const meaningfulWords = clean.replace(/[\d\s()+.\-]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const bad = ["sex","sexual","nude","naked","porn","kill","murder","attack","weapon","gun","stab","blood","violent","violence"];
  if (bad.some((t) => clean.includes(t))) {
    return "This space is for gentle emotional sharing. Posts using sexual or violent language cannot be posted here. For direct support, email Sattvapathcollective@gmail.com.";
  }
  if ((phoneLike && asksForPhone && meaningfulWords.length <= 4) || (asksOnlyForPhone && meaningfulWords.length <= 8)) {
    return "Please do not post only a phone number or a request for a phone number here. For contact, email Sattvapathcollective@gmail.com. Retreat location: Enchanted Hills Retreat, 3568 Mt Veeder Rd, Napa, CA 94558.";
  }
  return "";
}

function setSpeechStatus(msg) { if (speechStatus) speechStatus.textContent = msg; }

function enhanceSpeechFields(root = document) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  root.querySelectorAll("[data-speech]").forEach((field) => {
    if (field.dataset.speechReady === "true") return;
    field.dataset.speechReady = "true";
    const wrapper = document.createElement("div");
    wrapper.className = "speech-field";
    field.parentNode.insertBefore(wrapper, field);
    wrapper.appendChild(field);
    const button = document.createElement("button");
    button.className = "button secondary speech-button";
    button.type = "button";
    button.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"></path>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
        <path d="M12 19v3"></path>
        <path d="M8 22h8"></path>
      </svg>`;
    button.setAttribute("aria-label", `Use voice input for ${field.getAttribute("aria-label") || field.id || "this field"}`);
    button.title = "Use voice input";
    button.setAttribute("aria-pressed", "false");
    if (!SpeechRecognition) { button.disabled = true; button.title = "Voice input unavailable"; wrapper.appendChild(button); return; }
    button.addEventListener("click", () => {
      if (activeRecognition) { activeRecognition.stop(); activeRecognition = null; }
      const rec = new SpeechRecognition();
      activeRecognition = rec;
      rec.lang = "en-US"; rec.interimResults = false; rec.maxAlternatives = 1;
      button.setAttribute("aria-pressed", "true");
      setSpeechStatus("Listening. Speak now.");
      rec.onresult = (event) => {
        const transcript = event.results[0][0].transcript.trim();
        const sep = field.value && field.tagName === "TEXTAREA" ? " " : "";
        field.value = `${field.value}${sep}${transcript}`.trim();
        field.dispatchEvent(new Event("input", { bubbles: true }));
        setSpeechStatus("Speech added to the field.");
      };
      rec.onerror = () => setSpeechStatus("Voice input did not work. You can type or try again.");
      rec.onend = () => { button.setAttribute("aria-pressed", "false"); if (activeRecognition === rec) activeRecognition = null; };
      rec.start();
    });
    wrapper.appendChild(button);
  });
}

function paragraphsFromText(text) {
  return String(text || "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${p}</p>`).join("");
}

function applySiteContent() {
  const content = getJson("sattva-site-content", {});
  document.querySelectorAll("[data-content]").forEach((el) => {
    const v = content[el.dataset.content];
    if (!v) return;
    if (el.classList.contains("body-copy")) el.innerHTML = paragraphsFromText(v);
    else el.textContent = v;
  });
  document.querySelectorAll("[data-image]").forEach((image) => {
    const v = content[image.dataset.image];
    if (v) image.src = v;
  });
}

function renderCustomSections() {
  if (!customSectionGrid || !customSections) return;
  const sections = getJson("sattva-custom-sections").filter((s) => s.status === "Posted");
  customSections.hidden = sections.length === 0;
  customSectionGrid.innerHTML = sections.map((s) => `
    <article class="custom-section">
      ${s.image ? `<img src="${s.image}" alt="${escapeHtml(s.title)}">` : ""}
      <p class="section-kicker">${escapeHtml(s.kicker || "Sattva Path")}</p>
      <h3>${escapeHtml(s.title)}</h3>
      <div>${paragraphsFromText(s.body)}</div>
    </article>`).join("");
}

function renderGallery() {
  if (!siteGallery || !photoFilters) return;
  const images = getJson("sattva-images").filter((i) => i.status === "Posted");
  const categories = ["All", ...new Set(images.map((i) => i.category || "General"))];
  photoFilters.innerHTML = categories.map((cat) => `
    <button class="photo-filter ${cat === activePhotoCategory ? "is-active" : ""}" type="button" data-category="${escapeHtml(cat)}">${escapeHtml(cat)}</button>
  `).join("");
  const visible = activePhotoCategory === "All" ? images : images.filter((i) => (i.category || "General") === activePhotoCategory);
  if (!images.length) {
    siteGallery.innerHTML = `<article class="gallery-item"><h3>No photos posted yet.</h3><p>Past event photos added by the host will appear here.</p></article>`;
    return;
  }
  siteGallery.innerHTML = visible.map((image) => `
    <article class="gallery-item">
      <img src="${image.src}" alt="${escapeHtml(image.alt || image.title)}">
      <div class="event-tags"><span class="event-tag">${escapeHtml(image.category || "General")}</span></div>
      <h3>${escapeHtml(image.title)}</h3>
      ${image.caption ? `<p>${escapeHtml(image.caption)}</p>` : ""}
    </article>`).join("");
}

// ---------------------- Emotion board (API-backed) ----------------------

const EMOTION_COLORS = [
  { keys: ["peace","calm","serene","tranquil","quiet","still","content"], bg: "#BDD8EE", pin: "#3A6EA5" },
  { keys: ["hope","joy","joyful","happy","grateful","blessed","excite","light","glad","alive"], bg: "#FBE79A", pin: "#B8892C" },
  { keys: ["love","warm","tender","kind","open","soft"], bg: "#F4C2C2", pin: "#B8556A" },
  { keys: ["heavy","sad","low","tired","weary","grief","griev","exhaust","empty","lonely"], bg: "#D6D0C4", pin: "#6C6558" },
  { keys: ["uncertain","confused","anxious","worry","worried","scared","nervous","afraid","unsure","stuck"], bg: "#D2C4E1", pin: "#6E4A8F" },
  { keys: ["angry","frustrat","annoy","upset","tense","irritat"], bg: "#F0B8A0", pin: "#9C5238" },
  { keys: ["reflect","curious","thoughtful","seeking","learning"], bg: "#B9DAB6", pin: "#4E7A47" }
];

function emotionColor(word) {
  const key = String(word || "").toLowerCase();
  for (const c of EMOTION_COLORS) if (c.keys.some((k) => key.includes(k))) return c;
  return { bg: "#F0EAD6", pin: "#8A7748" };
}

function isCurrentMonth(iso) {
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

function emotionCardHTML(emotion, myClientId, indexHint = 0) {
  const communityOpen = emotion.community_response_preference === "Community may respond";
  const replies = emotion.community_replies || [];
  const isMine = emotion.client_id === myClientId;
  const c = emotionColor(emotion.word);
  const rotations = [-1.6, 1.4, -0.8, 2.1, -2.3, 0.8, -1.2, 1.9];
  const rot = rotations[indexHint % rotations.length];
  const style = `--sticky-bg:${c.bg};--sticky-pin:${c.pin};--sticky-rot:${rot}deg;`;
  return `
    <article class="emotion-card" style="${style}" data-emotion-id="${escapeHtml(emotion.id)}">
      <div class="sticky-word">${escapeHtml(emotion.word)}</div>
      <div class="sticky-name">— ${escapeHtml(emotion.name || "Anonymous")}</div>
      ${emotion.message ? `<div class="sticky-message">${escapeHtml(emotion.message)}</div>` : ""}
      ${emotion.public_response ? `<div class="host-response"><strong>Host response:</strong><br>${escapeHtml(emotion.public_response)}</div>` : ""}
      ${replies.length ? `
        <div class="community-replies">
          <strong>Community responses</strong>
          ${replies.map((r) => `
            <div class="community-reply">
              <strong>${escapeHtml(r.name || "Anonymous")}</strong>
              <p>${escapeHtml(r.message)}</p>
            </div>`).join("")}
        </div>` : ""}
      ${isMine ? `
        <div class="emotion-owner-actions">
          <button type="button" class="button secondary" data-emotion-edit="${escapeHtml(emotion.id)}">Edit</button>
          <button type="button" class="button secondary" data-emotion-delete="${escapeHtml(emotion.id)}">Delete</button>
        </div>` : ""}
      ${communityOpen ? `
        <form class="reply-form" data-reply-form="${emotion.id}">
          <input data-speech data-reply-name placeholder="Your name, or leave blank for anonymous">
          <textarea data-speech data-reply-message required placeholder="Offer a kind response"></textarea>
          <button class="button secondary" type="submit">Respond</button>
        </form>` : ""}
    </article>`;
}

async function renderEmotions() {
  if (!emotionList) return;
  try {
    const all = await apiGet("/api/emotions");
    const current = all.filter((e) => isCurrentMonth(e.created_at));
    const archived = all.filter((e) => !isCurrentMonth(e.created_at));

    emotionList.innerHTML = current.length
      ? current.map((e, i) => emotionCardHTML(e, CLIENT_ID, i)).join("")
      : `<article class="emotion-card empty" style="--sticky-bg:#F0EAD6;--sticky-pin:#8A7748;--sticky-rot:-1deg;">
          <div class="sticky-word">Quiet</div>
          <div class="sticky-message">No feelings shared yet this month. Be the first to name what is present.</div>
        </article>`;
    enhanceSpeechFields(emotionList);

    const archiveEl = document.querySelector("#emotionArchive");
    const archiveListEl = document.querySelector("#emotionArchiveList");
    if (archiveEl && archiveListEl) {
      if (archived.length) {
        archiveEl.hidden = false;
        archiveListEl.innerHTML = archived.map((e, i) => emotionCardHTML(e, CLIENT_ID, i)).join("");
        enhanceSpeechFields(archiveListEl);
      } else {
        archiveEl.hidden = true;
      }
    }
  } catch (err) {
    emotionList.innerHTML = `<div class="empty-state">Could not load the board right now. Please refresh.</div>`;
  }
}

if (photoFilters) {
  photoFilters.addEventListener("click", (event) => {
    const category = event.target.dataset.category;
    if (!category) return;
    activePhotoCategory = category;
    renderGallery();
  });
}

if (hostResponsePreference && emotionEmailWrap && emotionEmail) {
  hostResponsePreference.addEventListener("change", () => {
    const needsEmail = hostResponsePreference.value === "Host may respond privately";
    emotionEmailWrap.hidden = !needsEmail;
    emotionEmail.required = needsEmail;
    if (!needsEmail) emotionEmail.value = "";
  });
}

if (emotionForm) {
  emotionForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!emotionForm.checkValidity()) {
      emotionForm.reportValidity();
      showHeartStatus("Please complete the required fields before posting.", "error");
      return;
    }
    const hostPreference = hostResponsePreference.value;
    const wordValue = document.querySelector("#emotionWord").value.trim();
    const messageValue = document.querySelector("#emotionMessage").value.trim();
    const warning = heartPostWarning([wordValue, messageValue].join(" "));
    if (warning) { showHeartStatus(warning, "error"); return; }
    const nameValue = document.querySelector("#emotionName").value.trim();
    const emailValue = hostPreference === "Host may respond privately"
      ? document.querySelector("#emotionEmail").value.trim() : "";
    const editId = emotionForm.dataset.editId || "";
    const payload = {
      name: nameValue, word: wordValue, message: messageValue,
      host_response_preference: hostPreference,
      community_response_preference: communityResponsePreference.value,
      email: emailValue
    };
    try {
      if (editId) {
        await apiPatch(`/api/emotions/${editId}`, payload, CLIENT_HEADER);
        emotionForm.dataset.editId = "";
        showHeartStatus("Your note has been updated.", "success");
      } else {
        await apiPost(`/api/emotions`, payload, CLIENT_HEADER);
        showHeartStatus("Thank you. Your note has been added to What's on Your Heart.", "success");
      }
      emotionForm.reset();
      emotionEmailWrap.hidden = true;
      emotionEmail.required = false;
      renderEmotions();
    } catch (err) {
      showHeartStatus(err.message === "rate_limited"
        ? "Please slow down a moment before posting again."
        : "Your note could not be saved right now. Please try again.", "error");
    }
  });
}

async function handleEmotionOwnerClick(event) {
  const editId = event.target.dataset.emotionEdit;
  const deleteId = event.target.dataset.emotionDelete;
  if (!editId && !deleteId) return;

  if (editId) {
    // Load current values from the API and populate the modal
    let e;
    try {
      const all = await apiGet("/api/emotions");
      e = all.find((x) => x.id === editId);
    } catch { return; }
    if (!e) return;
    document.querySelector("#emotionName").value = e.name || "";
    document.querySelector("#emotionWord").value = e.word || "";
    document.querySelector("#emotionMessage").value = e.message || "";
    document.querySelector("#hostResponsePreference").value = e.host_response_preference || "No host response";
    document.querySelector("#communityResponsePreference").value = e.community_response_preference || "No community response";
    const needsEmail = e.host_response_preference === "Host may respond privately";
    document.querySelector("#emotionEmailWrap").hidden = !needsEmail;
    document.querySelector("#emotionEmail").required = needsEmail;
    document.querySelector("#emotionEmail").value = "";  // API doesn't return email
    emotionForm.dataset.editId = editId;
    const modal = document.querySelector("#emotionModal");
    const title = document.querySelector("#emotionModalTitle");
    const submitBtn = emotionForm.querySelector('button[type="submit"]');
    if (title) title.textContent = "Edit your post";
    if (submitBtn) submitBtn.textContent = "Save changes";
    if (modal) {
      modal.hidden = false;
      document.body.style.overflow = "hidden";
      setTimeout(() => document.querySelector("#emotionWord")?.focus(), 40);
    }
    return;
  }

  if (deleteId) {
    if (!confirm("Delete this post from the emotion board? This cannot be undone.")) return;
    try {
      await apiDelete(`/api/emotions/${deleteId}`, CLIENT_HEADER);
      await renderEmotions();
      showHeartStatus("Your post has been deleted.", "success");
    } catch {
      showHeartStatus("Could not delete right now.", "error");
    }
  }
}

if (emotionList) {
  emotionList.addEventListener("click", handleEmotionOwnerClick);
  const archiveListEl = document.querySelector("#emotionArchiveList");
  archiveListEl?.addEventListener("click", handleEmotionOwnerClick);

  emotionList.addEventListener("submit", async (event) => {
    const replyForm = event.target.closest("[data-reply-form]");
    if (!replyForm) return;
    event.preventDefault();
    const id = replyForm.dataset.replyForm;
    const message = replyForm.querySelector("[data-reply-message]").value.trim();
    if (!message) return;
    const warning = heartPostWarning(message);
    if (warning) { showHeartStatus(warning, "error"); return; }
    const name = replyForm.querySelector("[data-reply-name]").value.trim();
    try {
      await apiPost(`/api/emotions/${id}/reply`, { name, message });
      showHeartStatus("Your community response has been added.", "success");
      renderEmotions();
    } catch (err) {
      showHeartStatus(err.message === "rate_limited"
        ? "Please slow down a moment before responding again."
        : "Your response could not be saved.", "error");
    }
  });
}

document.querySelectorAll("[data-question]").forEach((btn) => {
  btn.addEventListener("click", () => askAssistant(btn.dataset.question));
});

if (form && input) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    askAssistant(input.value);
    input.value = "";
    input.focus();
  });
}

// ---------------------- Events (API-backed) ----------------------

const FEATURED_RETREAT_ID = "sattva-path-retreat-2026";

async function renderFeaturedRetreat() {
  try {
    const featured = await apiGet(`/api/events/${FEATURED_RETREAT_ID}`);
    if (!featured) return;
    const set = (key, value) => {
      document.querySelectorAll(`[data-featured-retreat="${key}"]`).forEach((el) => {
        if (value !== undefined && value !== null && value !== "") el.textContent = value;
      });
    };
    set("title", featured.title);
    set("date", featured.date);
    set("location", featured.location);
    set("age", featured.age);
    set("description", featured.description);
    set("price", featured.price);

    const isClosed = featured.status === "Closed";
    document.querySelectorAll('[data-featured-retreat="register-btn"]').forEach((el) => el.hidden = isClosed);
    document.querySelectorAll('[data-featured-retreat="closed-notice"]').forEach((el) => el.hidden = !isClosed);
  } catch { /* keep hardcoded HTML as fallback */ }
}

function wideEventCardHTML(event, options = {}) {
  const closed = event.status === "Closed";
  const detailRows = [
    event.date && `<div><span class="wide-event-label">Date</span><span>${escapeHtml(event.date)}</span></div>`,
    event.location && `<div><span class="wide-event-label">Location</span><span>${escapeHtml(event.location)}</span></div>`,
    event.price && `<div><span class="wide-event-label">Fee</span><span>${escapeHtml(event.price)}</span></div>`,
    event.age && `<div><span class="wide-event-label">Age</span><span>${escapeHtml(event.age)}</span></div>`
  ].filter(Boolean).join("");
  const registerBtn = closed ? "" : `<a class="button" href="event-register.html?id=${escapeHtml(event.id)}">Register</a>`;
  const detailsBtn = options.detailsHref ? `<a class="button secondary" href="${options.detailsHref}">${options.detailsLabel || "View details"}</a>` : "";
  return `
    <article class="wide-event${closed ? " is-closed" : ""}">
      ${closed ? '<span class="closed-badge">Registration closed</span>' : ""}
      <h3>${escapeHtml(event.title)}</h3>
      ${event.description ? `<p>${escapeHtml(event.description)}</p>` : ""}
      ${detailRows ? `<div class="wide-event-meta">${detailRows}</div>` : ""}
      ${(registerBtn || detailsBtn) ? `<div class="actions">${detailsBtn}${registerBtn}</div>` : ""}
    </article>`;
}

async function renderEventsByType(type, containerId, emptyMessage) {
  const container = document.querySelector(`#${containerId}`);
  if (!container) return;
  try {
    const events = await apiGet(`/api/events?type=${encodeURIComponent(type)}`);
    const filtered = events.filter((e) => e.id !== FEATURED_RETREAT_ID);
    if (!filtered.length) {
      container.innerHTML = `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
      return;
    }
    container.innerHTML = filtered.map((e) => wideEventCardHTML(e)).join("");
  } catch {
    container.innerHTML = `<div class="empty-state">Could not load events right now.</div>`;
  }
}

async function renderDynamicEvents() {
  if (!dynamicEvents) return;
  try {
    const events = await apiGet("/api/events");
    const visible = events.filter((e) => e.status === "Posted" && e.id !== FEATURED_RETREAT_ID);
    if (!visible.length) {
      dynamicEvents.innerHTML = `
        <article class="dynamic-event">
          <div class="event-tags"><span class="event-tag">Owner area</span></div>
          <h3>No additional events posted yet.</h3>
          <p>Create meditation, kirtan/bhajan, or future retreat events from the admin panel.</p>
          <div class="actions"><a class="button secondary" href="admin.html">Open Admin</a></div>
        </article>`;
      return;
    }
    dynamicEvents.innerHTML = visible.map((event) => `
      <article class="dynamic-event">
        <div class="event-tags">
          <span class="event-tag">${escapeHtml(event.type)}</span>
          <span class="event-tag">${escapeHtml(event.date)}</span>
        </div>
        <h3>${escapeHtml(event.title)}</h3>
        <p>${escapeHtml(event.location)}</p>
        <p>${escapeHtml(event.description)}</p>
        ${event.price ? `<p><strong>Fee:</strong> ${escapeHtml(event.price)}</p>` : ""}
        ${event.age ? `<p><strong>Age:</strong> ${escapeHtml(event.age)}</p>` : ""}
        <div class="actions">
          <a class="button" href="event-register.html?id=${escapeHtml(event.id)}">Register</a>
        </div>
      </article>`).join("");
  } catch { /* keep old content if any */ }
}

// ---------------------- init ----------------------

renderFeaturedRetreat();
renderDynamicEvents();
renderEventsByType("Retreat", "retreatEvents", "No additional retreat dates posted yet.");
renderEventsByType("Meditation", "meditationEvents", "No meditation gatherings posted yet. Check back soon.");
renderEventsByType("Kirtan/Bhajan", "kirtanEvents", "No kirtan or bhajan gatherings posted yet. Check back soon.");
applySiteContent();
renderCustomSections();
renderGallery();
renderEmotions();
enhanceSpeechFields();
