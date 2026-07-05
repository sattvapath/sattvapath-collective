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

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function hostPreferenceLabel(emotion) {
  const preference = emotion.hostResponsePreference || emotion.responsePreference || "No host response";
  if (preference === "Public response") return "Host may respond publicly";
  if (preference === "Private response") return "Host may respond privately";
  if (preference === "No response needed") return "No host response";
  return preference;
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
  const found = answers.find((item) =>
    item.match.some((word) => normalized.includes(word))
  );
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
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function setJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function heartPostWarning(text) {
  const clean = String(text || "").toLowerCase();
  const phoneLike = clean.replace(/\D/g, "").length >= 7;
  const asksForPhone = /\b(phone|number|call|text|contact|mobile)\b/.test(clean);
  const asksOnlyForPhone = /\b(what|share|send|give|provide|need|want|asking|ask)\b.*\b(phone|number|mobile)\b/.test(clean);
  const meaningfulWords = clean
    .replace(/[\d\s()+.\-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);
  const sexualOrViolentTerms = [
    "sex", "sexual", "nude", "naked", "porn", "kill", "murder", "attack", "weapon", "gun", "stab", "blood", "violent", "violence"
  ];

  if (sexualOrViolentTerms.some((term) => clean.includes(term))) {
    return "This space is for gentle emotional sharing. Posts using sexual or violent language cannot be posted here. For direct support, email Sattvapathcollective@gmail.com.";
  }

  if ((phoneLike && asksForPhone && meaningfulWords.length <= 4) || (asksOnlyForPhone && meaningfulWords.length <= 8)) {
    return "Please do not post only a phone number or a request for a phone number here. For contact, email Sattvapathcollective@gmail.com. Retreat location: Enchanted Hills Retreat, 3568 Mt Veeder Rd, Napa, CA 94558.";
  }

  return "";
}

function setSpeechStatus(message) {
  if (speechStatus) speechStatus.textContent = message;
}

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
      </svg>
    `;
    button.setAttribute("aria-label", `Use voice input for ${field.getAttribute("aria-label") || field.id || "this field"}`);
    button.title = "Use voice input";
    button.setAttribute("aria-pressed", "false");

    if (!SpeechRecognition) {
      button.disabled = true;
      button.title = "Voice input is unavailable in this browser";
      wrapper.appendChild(button);
      return;
    }

    button.addEventListener("click", () => {
      if (activeRecognition) {
        activeRecognition.stop();
        activeRecognition = null;
      }

      const recognition = new SpeechRecognition();
      activeRecognition = recognition;
      recognition.lang = "en-US";
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      button.setAttribute("aria-pressed", "true");
      setSpeechStatus("Listening. Speak now.");

      recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript.trim();
        const separator = field.value && field.tagName === "TEXTAREA" ? " " : "";
        field.value = `${field.value}${separator}${transcript}`.trim();
        field.dispatchEvent(new Event("input", { bubbles: true }));
        setSpeechStatus("Speech added to the field.");
      };

      recognition.onerror = () => {
        setSpeechStatus("Voice input did not work. You can type or try again.");
      };

      recognition.onend = () => {
        button.setAttribute("aria-pressed", "false");
        if (activeRecognition === recognition) activeRecognition = null;
      };

      recognition.start();
    });

    wrapper.appendChild(button);
  });
}

function paragraphsFromText(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${paragraph}</p>`)
    .join("");
}

function applySiteContent() {
  const content = getJson("sattva-site-content", {});
  document.querySelectorAll("[data-content]").forEach((element) => {
    const value = content[element.dataset.content];
    if (!value) return;
    if (element.classList.contains("body-copy")) {
      element.innerHTML = paragraphsFromText(value);
    } else {
      element.textContent = value;
    }
  });

  document.querySelectorAll("[data-image]").forEach((image) => {
    const value = content[image.dataset.image];
    if (value) image.src = value;
  });
}

function renderCustomSections() {
  if (!customSectionGrid || !customSections) return;
  const sections = getJson("sattva-custom-sections")
    .filter((section) => section.status === "Posted");
  customSections.hidden = sections.length === 0;
  customSectionGrid.innerHTML = sections.map((section) => `
    <article class="custom-section">
      ${section.image ? `<img src="${section.image}" alt="${section.title}">` : ""}
      <p class="section-kicker">${section.kicker || "Sattva Path"}</p>
      <h3>${section.title}</h3>
      <div>${paragraphsFromText(section.body)}</div>
    </article>
  `).join("");
}

function renderGallery() {
  if (!siteGallery || !photoFilters) return;
  const images = getJson("sattva-images")
    .filter((image) => image.status === "Posted");
  const categories = ["All", ...new Set(images.map((image) => image.category || "General"))];
  photoFilters.innerHTML = categories.map((category) => `
    <button class="photo-filter ${category === activePhotoCategory ? "is-active" : ""}" type="button" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>
  `).join("");

  const visibleImages = activePhotoCategory === "All"
    ? images
    : images.filter((image) => (image.category || "General") === activePhotoCategory);

  if (!images.length) {
    siteGallery.innerHTML = `
      <article class="gallery-item">
        <h3>No photos posted yet.</h3>
        <p>Past event photos added by the host will appear here.</p>
      </article>
    `;
    return;
  }

  siteGallery.innerHTML = visibleImages.map((image) => `
    <article class="gallery-item">
      <img src="${image.src}" alt="${image.alt || image.title}">
      <div class="event-tags"><span class="event-tag">${escapeHtml(image.category || "General")}</span></div>
      <h3>${escapeHtml(image.title)}</h3>
      ${image.caption ? `<p>${escapeHtml(image.caption)}</p>` : ""}
    </article>
  `).join("");
}

function renderEmotions() {
  if (!emotionList) return;
  const emotions = getJson("sattva-emotions")
    .filter((emotion) => emotion.status !== "Hidden")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  emotionList.innerHTML = emotions.length ? emotions.map((emotion) => {
    const hostPreference = hostPreferenceLabel(emotion);
    const communityPreference = emotion.communityResponsePreference || "No community response";
    const communityOpen = communityPreference === "Community may respond";
    const replies = emotion.communityReplies || [];
    return `
      <article class="emotion-card">
        <div class="event-tags">
          <span class="event-tag">${escapeHtml(emotion.word)}</span>
        </div>
        <h3>${escapeHtml(emotion.name || "Anonymous")}</h3>
        <p>${escapeHtml(emotion.message)}</p>
        ${emotion.publicResponse ? `<div class="host-response"><strong>Host response:</strong><br>${escapeHtml(emotion.publicResponse)}</div>` : ""}
        ${replies.length ? `
          <div class="community-replies">
            <strong>Community responses</strong>
            ${replies.map((reply) => `
              <div class="community-reply">
                <strong>${escapeHtml(reply.name || "Anonymous")}</strong>
                <p>${escapeHtml(reply.message)}</p>
              </div>
            `).join("")}
          </div>
        ` : ""}
        ${communityOpen ? `
          <form class="reply-form" data-reply-form="${emotion.id}">
            <input data-speech data-reply-name placeholder="Your name, or leave blank for anonymous">
            <textarea data-speech data-reply-message required placeholder="Offer a kind response"></textarea>
            <button class="button secondary" type="submit">Respond</button>
          </form>
        ` : ""}
      </article>
    `;
  }).join("") : `
    <article class="emotion-card">
      <h3>No emotions shared yet.</h3>
      <p>This board is open when someone feels ready to name what is present for them.</p>
    </article>
  `;
  enhanceSpeechFields(emotionList);
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
  emotionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!emotionForm.checkValidity()) {
      emotionForm.reportValidity();
      showHeartStatus("Please complete the required fields before posting.", "error");
      return;
    }
    const hostPreference = hostResponsePreference.value;
    const warning = heartPostWarning([
      document.querySelector("#emotionWord").value,
      document.querySelector("#emotionMessage").value
    ].join(" "));
    if (warning) {
      showHeartStatus(warning, "error");
      return;
    }
    const emotions = getJson("sattva-emotions");
    try {
      emotions.push({
        id: crypto.randomUUID(),
        status: "Posted",
        createdAt: new Date().toISOString(),
        name: document.querySelector("#emotionName").value.trim(),
        word: document.querySelector("#emotionWord").value.trim(),
        message: document.querySelector("#emotionMessage").value.trim(),
        hostResponsePreference: hostPreference,
        communityResponsePreference: communityResponsePreference.value,
        email: hostPreference === "Host may respond privately" ? document.querySelector("#emotionEmail").value.trim() : "",
        publicResponse: "",
        communityReplies: []
      });
      setJson("sattva-emotions", emotions);
      emotionForm.reset();
      emotionEmailWrap.hidden = true;
      emotionEmail.required = false;
      showHeartStatus("Thank you. Your note has been added to What's on Your Heart.", "success");
      renderEmotions();
    } catch {
      showHeartStatus("Your note could not be saved in this browser. Please try again or contact the host.", "error");
    }
  });
}

if (emotionList) {
  emotionList.addEventListener("submit", (event) => {
    const replyForm = event.target.closest("[data-reply-form]");
    if (!replyForm) return;
    event.preventDefault();
    const emotions = getJson("sattva-emotions");
    const emotion = emotions.find((item) => item.id === replyForm.dataset.replyForm);
    if (!emotion || emotion.communityResponsePreference !== "Community may respond") return;
    const message = replyForm.querySelector("[data-reply-message]").value.trim();
    if (!message) return;
    const warning = heartPostWarning(message);
    if (warning) {
      showHeartStatus(warning, "error");
      return;
    }
    try {
      emotion.communityReplies = emotion.communityReplies || [];
      emotion.communityReplies.push({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        name: replyForm.querySelector("[data-reply-name]").value.trim(),
        message
      });
      setJson("sattva-emotions", emotions);
      showHeartStatus("Your community response has been added.", "success");
      renderEmotions();
    } catch {
      showHeartStatus("Your response could not be saved in this browser. Please try again.", "error");
    }
  });
}

document.querySelectorAll("[data-question]").forEach((button) => {
  button.addEventListener("click", () => askAssistant(button.dataset.question));
});

if (form && input) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    askAssistant(input.value);
    input.value = "";
    input.focus();
  });
}

const FEATURED_RETREAT_ID = "sattva-path-retreat-2026";

function renderFeaturedRetreat() {
  const events = getJson("sattva-events");
  const featured = events.find((e) => e.id === FEATURED_RETREAT_ID);
  if (!featured) return;
  if (featured.status !== "Posted" && featured.status !== "Closed") return;

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
  document.querySelectorAll('[data-featured-retreat="register-btn"]').forEach((el) => {
    el.hidden = isClosed;
  });
  document.querySelectorAll('[data-featured-retreat="closed-notice"]').forEach((el) => {
    el.hidden = !isClosed;
  });
}

function renderDynamicEvents() {
  if (!dynamicEvents) return;
  const events = getJson("sattva-events")
    .filter((event) => event.status === "Posted")
    .filter((event) => event.id !== FEATURED_RETREAT_ID);

  if (!events.length) {
    dynamicEvents.innerHTML = `
      <article class="dynamic-event">
        <div class="event-tags">
          <span class="event-tag">Owner area</span>
        </div>
        <h3>No additional events posted yet.</h3>
        <p>Use the owner/admin link in the footer to create meditation, kirtan/bhajan, or future retreat events.</p>
        <div class="actions">
          <a class="button secondary" href="admin.html">Open Admin</a>
        </div>
      </article>
    `;
    return;
  }

  dynamicEvents.innerHTML = events.map((event) => `
    <article class="dynamic-event">
      <div class="event-tags">
        <span class="event-tag">${event.type}</span>
        <span class="event-tag">${event.date}</span>
      </div>
      <h3>${event.title}</h3>
      <p>${event.location}</p>
      <p>${event.description}</p>
      ${event.price ? `<p><strong>Fee:</strong> ${event.price}</p>` : ""}
      ${event.age ? `<p><strong>Age:</strong> ${event.age}</p>` : ""}
      <div class="actions">
        <a class="button" href="event-register.html?id=${event.id}">Register</a>
      </div>
    </article>
  `).join("");
}

renderFeaturedRetreat();
renderDynamicEvents();
applySiteContent();
renderCustomSections();
renderGallery();
renderEmotions();
enhanceSpeechFields();
