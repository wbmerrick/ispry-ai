window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
(function(){
  // Stripe-hosted membership checkout + self-service portal. /api/checkout may override (Stripe hosts only).
  var CHECKOUT_URL = "https://buy.stripe.com/4gM7sNehu4CUcef1PL7Zu01";
  var VISIT_URL = "";
  var PORTAL_URL = "https://billing.stripe.com/p/login/28EfZjb5i0mEa679id7Zu00";
  var CHECKOUT_PLAN_KEY = "ispry_checkout_plan";
  var OFFER_KEY = "ispry_offer";
  var activePathway = null;
  var educationSummary = "";
  var synopsisText = "";
  var chatStarted = false;
  // The condition a patient chose never goes into the checkout URL (Stripe is not under a BAA).
  function pathwaySignupUrl(){ return CHECKOUT_URL; }
  function applyJoinLinks(){
    // Direct Stripe links are only for a signed-in patient who already consented
    // (the post-intake handoff and the paid-visit upgrade). The public
    // "Become a member" button stays on #ask.
    document.querySelectorAll(".js-join-direct").forEach(function(a){ a.href = CHECKOUT_URL; });
    document.querySelectorAll(".js-visit").forEach(function(a){
      if (VISIT_URL) a.href = VISIT_URL;
      else a.href = "#ask";
    });
    document.querySelectorAll(".js-portal").forEach(function(a){ a.href = PORTAL_URL; });
    var pathLink = document.getElementById("pathCheckout");
    if (pathLink) pathLink.href = pathwaySignupUrl();
  }
  function consentedMember(){
    var session = window.IspryAccount && window.IspryAccount.hasSession && window.IspryAccount.hasSession();
    var ok = false;
    try { ok = sessionStorage.getItem("ispry_consent_ok") === "1"; } catch (e) {}
    return !!(session && ok);
  }
  function sectionId(el){
    var section = el && el.closest ? el.closest("section") : null;
    return section ? (section.id || "nav") : "nav";
  }
  function rememberCheckout(plan){
    try { sessionStorage.setItem(CHECKOUT_PLAN_KEY, plan === "visit" ? "visit" : "membership"); } catch (e) {}
  }
  function rememberOffer(plan){
    try {
      if (plan) sessionStorage.setItem(OFFER_KEY, plan);
      else sessionStorage.removeItem(OFFER_KEY);
    } catch (e) {}
  }
  // Vercel Web Analytics custom events (no identifiers, ever). Silent when analytics is off.
  function track(name, props){
    try { if (window.va) window.va("event", { name: name, data: props || {} }); } catch (e) {}
  }
  var VISIT_HINT = "You're starting a $49 one-time visit. Create or sign in to your account, then describe the one problem. Telehealth consent comes before payment. You can upgrade to membership later.";
  var MEMBER_HINT = "You're starting a $100/month membership. Create or sign in, tell Spry what's going on, and confirm telehealth consent. Payment opens only after that.";
  document.addEventListener("click", function(e){
    var direct = e.target.closest(".js-join-direct");
    if (direct) {
      track("checkout_click", { where: sectionId(direct), plan: "membership" });
      if (stripeHosted(direct.getAttribute("href") || direct.href)) rememberCheckout("membership");
    }
    var offer = e.target.closest(".js-membership-offer");
    if (offer) {
      if (consentedMember()) {
        offer.href = CHECKOUT_URL;
        track("checkout_click", { where: sectionId(offer), plan: "membership" });
        rememberCheckout("membership");
      } else {
        e.preventDefault();
        track("checkout_click", { where: sectionId(offer), plan: "membership" });
        rememberOffer("membership");
        if (intakeHint && !intakeHint.classList.contains("err")) intakeHint.textContent = MEMBER_HINT;
        var idle = document.getElementById("qIdle");
        if (idle) { try { idle.focus(); } catch (err) {} }
        if (location.hash !== "#ask") location.hash = "ask";
      }
    }
    var visit = e.target.closest(".js-visit");
    if (visit) {
      track("checkout_click", { where: sectionId(visit), plan: "visit" });
      var visitHref = visit.getAttribute("href") || visit.href || "";
      if (stripeHosted(visitHref)) rememberCheckout("visit");
      else {
        rememberOffer("visit");
        if (intakeHint && !intakeHint.classList.contains("err")) intakeHint.textContent = VISIT_HINT;
      }
    }
    var portal = e.target.closest(".js-portal"); if (portal) track("portal_click");
  });
  function ensureAccount(opts){
    if (!window.IspryAccount) return Promise.reject(new Error("Account is still loading. Please try again."));
    return window.IspryAccount.require(opts || {});
  }
  var MEDICAL_EMERGENCY_RE = /chest (pain|pressure|tight|hurts)|crushing chest|heart attack|can'?t breathe|cannot breathe|can'?t catch (my )?breath|cannot catch (my )?breath|trouble breathing|difficulty breathing|hard to breathe|breathing (is |feels )?(tight|hard|difficult)|tight breathing|short(ness)? of breath|muffled voice|stroke|face droop|slurred speech|overdose|poison|unconscious|passed out|\b(?:fainted|fainting|faintness)\b|\b(?:feel|feels|feeling|felt|got|gotten|getting|gets|went|become|becomes|became|becoming|turned|turning)\s+faint\b|\b(?:about|going)\s+to\s+faint\b|seizure|severe bleeding|coughing (up )?blood|anaphyla|throat (is )?(closing|swelling)|airway/i;
  var CRISIS_RE = /suicid|kill myself|end my life|ending it all|self[- ]?harm|want to die|hurt myself|cut myself|homicid|kill (him|her|them|someone|people)|hurt (him|her|them|someone) on purpose/i;
  var EMERGENCY_RE = new RegExp("(?:" + MEDICAL_EMERGENCY_RE.source + ")|(?:" + CRISIS_RE.source + ")", "i");
  var NEG_BEFORE = /\b(no|not|denies|deny|denied|without|never|negative for|don'?t have|do not have|doesn'?t have|haven'?t had|has not had|have not had)\s+(had\s+)?(a\s+|an\s+|any\s+|really\s+|much\s+)?((\w+[\s,]+){1,4}or\s+)?$/i;
  function matchFlags(re, text){
    var out = [], r = new RegExp(re.source, "gi"), s = String(text || ""), m;
    while ((m = r.exec(s))) {
      if (!NEG_BEFORE.test(s.slice(Math.max(0, m.index - 40), m.index))) out.push(m[0]);
    }
    return out;
  }
  function isCrisis(text){ return matchFlags(CRISIS_RE, text).length > 0; }
  function isEmergency(text){ return matchFlags(EMERGENCY_RE, text).length > 0; }
  function uniqueFlags(list){
    var seen = {}, out = [];
    (list || []).forEach(function(s){
      var k = String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!k || seen[k]) return;
      seen[k] = true;
      out.push(String(s).replace(/\s+/g, " ").trim());
    });
    return out;
  }
  function medicalReasonFromText(text){
    var named = uniqueFlags(matchFlags(MEDICAL_EMERGENCY_RE, text)).slice(0, 4);
    if (!named.length) return "What you described needs emergency care now — not an online visit.";
    return "These symptoms need emergency care now — especially: " + named.join(", ") + ".";
  }
  var history = [];
  var pendingAskText = "";
  var gateInFlight = false;
  var busy = false;
  var locked = false;
  var intakeSent = false;
  var akuteRedirectTimer = null;
  window.addEventListener("pagehide", function(){
    if (akuteRedirectTimer){ clearTimeout(akuteRedirectTimer); akuteRedirectTimer = null; }
  });
  var chatDock = document.getElementById("chatDock");
  var intakeHint = document.getElementById("intakeHint");
  var INTAKE_HINT = "Free account first — then Ask Spry. Age, sex, and Tennessee are collected there. Leave name and birthdate out of chat.";
  function storedOffer(){
    try { return sessionStorage.getItem(OFFER_KEY) || ""; } catch (e) { return ""; }
  }
  function hintForAccount(p){
    if (p && p.first_name) return "Signed in as " + p.first_name + ". Ask Spry below — a summary of what you tell Spry goes to your physician.";
    if (storedOffer() === "visit") return VISIT_HINT;
    if (storedOffer() === "membership") return MEMBER_HINT;
    return INTAKE_HINT;
  }
  function setHint(text){
    if (!intakeHint || intakeHint.classList.contains("err")) return;
    if (intakeHint.textContent === text) return;
    intakeHint.textContent = text;
  }
  // /member.html sends signed-out patients here as /?member=1: sign in, then go back.
  var wantMember = /[?&]member=1(?:&|$)/.test(location.search);
  function syncAccountUi(p){
    if (wantMember && p && p.first_name && window.IspryAccount && window.IspryAccount.hasSession()){
      wantMember = false;
      location.replace("/member.html");
      return;
    }
    var chip = document.getElementById("acctChip");
    var chipName = document.getElementById("acctChipName");
    var openBtn = document.getElementById("acctOpenBtn");
    if (p && p.first_name){
      if (chip){ chip.hidden = false; chip.classList.add("on"); }
      if (chipName) chipName.textContent = p.first_name;
      if (openBtn) openBtn.style.display = "none";
      if (intakeHint){
        intakeHint.classList.remove("err");
        setHint(hintForAccount(p));
      }
      var idleLabel = document.getElementById("sendIdleLabel");
      if (idleLabel) idleLabel.textContent = "Ask Spry";
      // Resume a chip/ask blocked by a cancelled gate (e.g. later Sign in from header).
      // Skip while ask() is already waiting on requireAccountForIntake to avoid a double send.
      if (pendingAskText && !busy && !locked && !gateInFlight){
        var resume = pendingAskText;
        pendingAskText = "";
        setTimeout(function(){ ask(resume); }, 0);
      }
    } else {
      if (chip){ chip.hidden = true; chip.classList.remove("on"); }
      if (openBtn) openBtn.style.display = "";
      setHint(hintForAccount(null));
      var idleLabelOff = document.getElementById("sendIdleLabel");
      if (idleLabelOff) idleLabelOff.textContent = "Create free account & ask Spry";
    }
  }
  var acctOpenBtn = document.getElementById("acctOpenBtn");
  if (acctOpenBtn) acctOpenBtn.addEventListener("click", function(){
    ensureAccount({ mode: "signin" }).catch(function(){});
  });
  var acctSignOut = document.getElementById("acctSignOut");
  if (acctSignOut) acctSignOut.addEventListener("click", function(){
    if (window.IspryAccount) window.IspryAccount.signOut();
  });
  if (window.IspryAccount){
    window.IspryAccount.onChange(syncAccountUi);
    window.IspryAccount.init().then(function(p){
      syncAccountUi(p);
      if (wantMember && !(p && p.first_name)) ensureAccount({ mode: "signin" }).catch(function(){});
    }).catch(function(){ syncAccountUi(null); });
  }

  var navToggle = document.getElementById("navToggle");
  var siteNav = document.getElementById("site-nav");
  function setNavOpen(open){
    if (!navToggle || !siteNav) return;
    siteNav.classList.toggle("open", open);
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
  }
  if (navToggle && siteNav){
    navToggle.addEventListener("click", function(){ setNavOpen(!siteNav.classList.contains("open")); });
    siteNav.addEventListener("click", function(e){ if (e.target.closest("a")) setNavOpen(false); });
    document.addEventListener("keydown", function(e){ if (e.key === "Escape") setNavOpen(false); });
    document.addEventListener("click", function(e){
      if (!siteNav.classList.contains("open")) return;
      if (e.target.closest("#site-nav") || e.target.closest("#navToggle")) return;
      setNavOpen(false);
    });
  }

  applyJoinLinks();
  // /api/checkout may point at a different Stripe link. It never leaves Stripe-hosted domains.
  function stripeHosted(url){
    try {
      var u = new URL(url);
      if (u.protocol !== "https:") return "";
      var host = u.hostname.toLowerCase();
      if (host !== "buy.stripe.com" && host !== "checkout.stripe.com" && host !== "billing.stripe.com") return "";
      return u.href;
    } catch (e) { return ""; }
  }
  fetch("/api/checkout", { headers: { Accept: "application/json" } })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(data){
      if (!data) return;
      var c = stripeHosted(data.signup_url), p = stripeHosted(data.portal_url);
      if (c) CHECKOUT_URL = c;
      if (p) PORTAL_URL = p;
      var visit = stripeHosted(data.visit_url);
      VISIT_URL = visit || "";
      applyJoinLinks();
      // Reflect live Stripe visit wiring on pricing CTAs / notes
      document.querySelectorAll(".js-visit").forEach(function(a){
        if (VISIT_URL) {
          a.setAttribute("href", VISIT_URL);
          if (a.classList.contains("btn")) a.textContent = "Start a $49 visit";
        }
      });
      document.querySelectorAll("[data-visit-note]").forEach(function(el){
        if (VISIT_URL) {
          el.textContent = "Secure checkout by Stripe. The $49 fee is for this visit only.";
        } else {
          el.textContent = "Visit checkout is not connected yet — Start a $49 visit opens Ask Spry and the office collects the fee.";
        }
      });
    })
    .catch(function(){});
  // Paid-state copy is not in the HTML. It appears only after this browser
  // started Stripe checkout and Stripe sent the patient back. A shared or
  // typed ?welcome=1 link does not show it, and the query is removed so the
  // address bar does not keep claiming a membership.
  (function consumePaidReturn(){
    var params;
    try { params = new URLSearchParams(location.search); } catch (e) { return; }
    if (!params.has("welcome")) return;
    var flag = params.get("welcome");
    var plan = "";
    try {
      plan = sessionStorage.getItem(CHECKOUT_PLAN_KEY) || "";
      sessionStorage.removeItem(CHECKOUT_PLAN_KEY);
    } catch (e) {}
    params.delete("welcome");
    var next = location.pathname + (params.toString() ? "?" + params.toString() : "") + location.hash;
    // `history` in this function is the chat transcript, not the browser history.
    try { window.history.replaceState(null, "", next || "/"); } catch (e) {}
    var known = flag === "1" || flag === "member" || flag === "membership" || flag === "visit";
    if (!known || (plan !== "visit" && plan !== "membership")) return;
    var el = document.getElementById("welcome");
    if (!el) return;
    if (plan === "visit") {
      el.innerHTML = "Payment received for your one-time visit. Dr. Merrick reviews requests 24/7, including nights, weekends, and holidays. Next: open <a href=\"/member.html\">My care</a> to add your address and pharmacy and to book. A confirmation email goes to the address you used at checkout. <a class=\"js-join-direct\" href=\"" +
        esc(CHECKOUT_URL) + "\">Upgrade to membership</a> any time for up to 3 visits a month.";
    } else {
      el.innerHTML = "Payment received. Your membership checkout is complete. Dr. Merrick reviews requests 24/7, including nights, weekends, and holidays. Next: open <a href=\"/member.html\">My care</a> to add your address and pharmacy and to book. A confirmation email goes to the address you used at checkout.";
    }
    el.hidden = false;
    el.classList.add("on");
    track("paid_return", { plan: plan });
  })();

  var form = document.getElementById("composer");
  var formIdle = document.getElementById("composerIdle");
  var q = document.getElementById("q");
  var qIdle = document.getElementById("qIdle");
  var send = document.getElementById("send");
  var sendIdle = document.getElementById("sendIdle");
  var chatShell = document.getElementById("chatShell");
  var idleStart = document.getElementById("idleStart");
  var msgsEl = document.getElementById("msgs");
  var chips = document.getElementById("chips");
  var TOPICS = {
    uti: "UTI symptoms",
    "sore-throat": "Sore throat",
    sinus: "Sinus pressure or congestion",
    ed: "Erectile dysfunction",
    "hair-loss": "Hair loss",
    "weight-loss": "Weight loss",
    refill: "Refill a medication.",
    sick: "Sick - need care today."
  };
  function applyTopic(topic){
    if (!Object.prototype.hasOwnProperty.call(TOPICS, topic)) return;
    var qText = TOPICS[topic];
    if (chips) {
      chips.querySelectorAll(".chip").forEach(function(b){
        var on = b.getAttribute("data-topic") === topic;
        b.setAttribute("aria-pressed", on ? "true" : "false");
        if (on) b.classList.add("on"); else b.classList.remove("on");
      });
    }
    if (qIdle && !qIdle.value.trim()) { qIdle.value = qText; try { autosize(qIdle); } catch (e) {} }
    track("topic", { topic: topic });
  }
  (function consumeEntry(){
    var params;
    try { params = new URLSearchParams(location.search); } catch (e) { return; }
    var topic = params.get("topic") || "";
    var offer = params.get("offer") || "";
    if (offer === "visit" || offer === "membership") {
      rememberOffer(offer);
      setHint(hintForAccount(window.IspryAccount && window.IspryAccount.get()));
    }
    if (topic) applyTopic(topic);
  })();
  var voiceReplies = localStorage.getItem("spry_voice") !== "0";
  var lastAskVoice = false;
  var speaking = false;
  var speakGen = 0;
  var currentAudio = null;
  var rec = null;
  var recSession = 0;
  var lastRecEnd = 0;
  var listenActive = false;
  var pendingTranscript = "";
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var talkBtns = [document.getElementById("talk"), document.getElementById("talkIdle")].filter(Boolean);
  var speakerBtn = document.getElementById("speaker");
  var voiceLine = document.getElementById("voiceLine");
  var voiceLineText = document.getElementById("voiceLineText");
  var SPEAKER_ON = '<path d="M4 10v4h4l5 4V6L8 10H4z"></path><path d="M16.5 8.5a5 5 0 0 1 0 7"></path><path d="M18.5 6a8 8 0 0 1 0 12"></path>';
  var SPEAKER_OFF = '<path d="M4 10v4h4l5 4V6L8 10H4z"></path><path d="M16 9l6 6M22 9l-6 6"></path>';

  function setVoiceLine(mode, text){
    if (!voiceLine) return;
    if (!mode){ voiceLine.className = "voice-line"; if (voiceLineText) voiceLineText.textContent = ""; return; }
    voiceLine.className = "voice-line on " + mode;
    if (voiceLineText) voiceLineText.textContent = text || "";
  }
  function clearIntakeBad(){
    if (intakeHint){
      var p = window.IspryAccount && window.IspryAccount.get();
      intakeHint.textContent = (p && p.first_name)
        ? hintForAccount(p)
        : hintForAccount(null);
      intakeHint.classList.remove("err");
    }
  }
  async function intakeToken(){
    return window.IspryAccount && window.IspryAccount.accessToken
      ? window.IspryAccount.accessToken()
      : "";
  }
  async function requireAccountForIntake(){
    var token = await intakeToken();
    if (hasAccount() && token) return true;
    gateInFlight = true;
    try {
      await ensureAccount({ mode: hasAccount() ? "signin" : "create" });
      token = await intakeToken();
      syncAccountUi(window.IspryAccount.get());
      upgradePathwayKickoff();
      if (hasAccount() && token) return true;
      if (intakeHint){
        intakeHint.textContent = "Please sign in to talk with Spry.";
        intakeHint.classList.add("err");
      }
      return false;
    } catch (e) {
      if (intakeHint){
        intakeHint.textContent = hasAccount()
          ? "Please sign in to talk with Spry."
          : "Create a free account to unlock Spry. Age, sex, and Tennessee are collected there.";
        intakeHint.classList.add("err");
      }
      return false;
    } finally {
      gateInFlight = false;
    }
  }
  function readIntake(){
    var p = window.IspryAccount && window.IspryAccount.get();
    if (!p) return { sex: "", age: NaN, loc: "" };
    return {
      sex: p.sex || "",
      age: Number(p.age),
      loc: p.in_tennessee ? "yes" : "no",
    };
  }
  function validateIntake(){
    clearIntakeBad();
    if (intakeSent) return true;
    var v = readIntake();
    if (!(v.age >= 18 && v.age <= 120) || (v.sex !== "male" && v.sex !== "female") || v.loc !== "yes"){
      if (intakeHint){
        if (v.loc === "no") intakeHint.textContent = "iSpry care is for patients physically in Tennessee — update that on your account.";
        else if (Number.isFinite(v.age) && v.age < 18) intakeHint.textContent = "iSpry membership is for adults 18 and older.";
        else intakeHint.textContent = "Start your iSpry account first — age, sex, and Tennessee are collected there.";
        intakeHint.classList.add("err");
      }
      return false;
    }
    return true;
  }
  function intakeLine(){
    if (window.IspryAccount && window.IspryAccount.get()){
      return window.IspryAccount.visitBasicsLine();
    }
    var v = readIntake();
    var sexLabel = v.sex === "female" ? "Female (F)" : "Male (M)";
    return "Visit basics — Age: " + v.age + ". Sex: " + sexLabel + ". In Tennessee now: Yes.";
  }
  function resetIntakeFields(){
    intakeSent = false;
    clearIntakeBad();
  }
  function setTalkRec(on){
    talkBtns.forEach(function(b){
      b.classList.toggle("rec", !!on);
      b.setAttribute("aria-label", on ? "Stop and send" : "Talk to Spry");
      b.setAttribute("title", on ? "Tap to send what you said" : "Tap to talk, tap again to send");
      var label = b.querySelector(".talk-label");
      if (label) label.textContent = on ? "Send" : "Talk";
    });
  }
  function setComposerEnabled(on){
    [send, sendIdle, q, qIdle].forEach(function(el){ if (el) el.disabled = !on; });
    talkBtns.forEach(function(b){ b.disabled = !on; });
  }
  function lockIntake(){
    locked = true;
    busy = true;
    stopListening(false);
    setComposerEnabled(false);
    clearQuick();
    if (chatDock) chatDock.style.display = "none";
    if (chips) chips.style.pointerEvents = "none";
  }
  function unlockIntake(){
    locked = false;
    busy = false;
    setComposerEnabled(true);
    if (chatDock) chatDock.style.display = "";
    if (chips) chips.style.pointerEvents = "";
  }
  function safeHttpsUrl(u){
    try {
      var x = new URL(String(u || ""));
      if (x.protocol !== "https:") return "";
      return x.href;
    } catch (e) { return ""; }
  }
  function applySpeakerUI(){
    if (!speakerBtn) return;
    speakerBtn.classList.toggle("speak-on", voiceReplies);
    speakerBtn.setAttribute("aria-pressed", voiceReplies ? "true" : "false");
    speakerBtn.setAttribute("aria-label", voiceReplies ? "Spry voice on" : "Spry voice muted");
    var icon = document.getElementById("speakerIcon");
    if (icon) icon.innerHTML = voiceReplies ? SPEAKER_ON : SPEAKER_OFF;
  }
  applySpeakerUI();
  if (speakerBtn){
    speakerBtn.addEventListener("click", function(){
      voiceReplies = !voiceReplies;
      localStorage.setItem("spry_voice", voiceReplies ? "1" : "0");
      applySpeakerUI();
      if (!voiceReplies) stopSpeaking();
    });
  }
  if (!SR) talkBtns.forEach(function(b){ b.style.display = "none"; });

  function forSpeech(text){
    return String(text || "")
      .replace(/\s*\[(EMERGENCY|READY|MEMBER|SYNOPSIS)\]\s*/gi, " ")
      .replace(/\s*\[(?:OPTIONS|CHECK)\b[^\]]*\]?\s*/gi, " ")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/[_`#]/g, "")
      .replace(/^\s*[-*\d]+[.)]\s+/gm, "")
      .replace(/\bGLP-1\b/gi, "G L P one")
      .replace(/\b988\b/g, "nine eight eight")
      .replace(/\b911\b/g, "nine one one")
      .replace(/\s+/g, " ")
      .trim();
  }
  function stopSpeaking(){
    speakGen += 1;
    speaking = false;
    if (currentAudio){
      try { currentAudio.onended = null; currentAudio.pause(); } catch (e) {}
      currentAudio = null;
    }
    if (window.speechSynthesis) try { speechSynthesis.cancel(); } catch (e) {}
    if (speakerBtn) speakerBtn.classList.remove("speaking");
  }
  function pickBrowserVoice(){
    if (!window.speechSynthesis) return null;
    var voices = speechSynthesis.getVoices() || [];
    var prefer = [/samantha/i, /jenny/i, /aria/i, /natural/i, /google us english/i, /microsoft.*(zira|aria|jenny)/i, /female/i];
    for (var i = 0; i < prefer.length; i++){
      var hit = voices.find(function(v){ return prefer[i].test(v.name) && /^en/i.test(v.lang || ""); });
      if (hit) return hit;
    }
    return voices.find(function(v){ return /^en(-|_)?US/i.test(v.lang || ""); }) || null;
  }
  function speakBrowser(text, gen){
    return new Promise(function(resolve){
      if (!window.speechSynthesis){ resolve(false); return; }
      var u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US"; u.rate = 1.15; u.pitch = 1.05;
      var v = pickBrowserVoice();
      if (v) u.voice = v;
      u.onend = function(){ resolve(gen === speakGen); };
      u.onerror = function(){ resolve(false); };
      try { speechSynthesis.speak(u); } catch (e) { resolve(false); }
    });
  }
  async function authHeaders(){
    var headers = { "Content-Type": "application/json" };
    var token = window.IspryAccount && window.IspryAccount.accessToken
      ? await window.IspryAccount.accessToken()
      : "";
    if (token) headers.Authorization = "Bearer " + token;
    return headers;
  }
  async function speakCloud(text, gen){
    try {
      var r = await fetch("/api/speak", {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ text: text.slice(0, 700) }),
      });
      if (!r.ok) throw new Error("tts");
      var blob = await r.blob();
      if (!blob || !blob.size || gen !== speakGen) throw new Error("empty");
      var url = URL.createObjectURL(blob);
      await new Promise(function(resolve){
        var audio = new Audio(url);
        currentAudio = audio;
        audio.onended = function(){ URL.revokeObjectURL(url); currentAudio = null; resolve(true); };
        audio.onerror = function(){ URL.revokeObjectURL(url); currentAudio = null; resolve(false); };
        var p = audio.play();
        if (p && p.catch) p.catch(function(){ resolve(false); });
      });
      return gen === speakGen;
    } catch (e) {
      return speakBrowser(text, gen);
    }
  }
  function resumeListenAfterSpeak(gen){
    // One clean listen turn after Spry finishes — only when the patient started by voice.
    // Echo-safe delay + no infinite auto-loop (Chrome STT needs a fresh start per turn).
    if (gen !== speakGen || !lastAskVoice || !voiceReplies || locked || busy || listenActive) return;
    setVoiceLine("listening", "Your turn — speak, then tap Send");
    setTimeout(function(){
      if (gen !== speakGen || !lastAskVoice || !voiceReplies || locked || busy || listenActive || speaking) return;
      startListening();
    }, 650);
  }
  async function speakReply(text){
    if (!voiceReplies) return false;
    var clean = forSpeech(text);
    if (!clean) return false;
    stopSpeaking();
    var gen = speakGen;
    // Prefer one fluent clip over sentence-by-sentence (less robotic pauses).
    var parts = [];
    if (clean.length <= 700) parts = [clean];
    else {
      var sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
      var buf = "";
      sentences.forEach(function(s){
        s = s.trim();
        if (!s) return;
        if (buf && (buf.length + 1 + s.length) > 700){ parts.push(buf); buf = s; }
        else buf = buf ? (buf + " " + s) : s;
      });
      if (buf) parts.push(buf);
    }
    speaking = true;
    if (speakerBtn) speakerBtn.classList.add("speaking");
    setVoiceLine("speaking", lastAskVoice
      ? "Spry is speaking — then your turn"
      : "Spry is speaking — tap Talk to answer");
    for (var i = 0; i < parts.length; i++){
      var part = parts[i].trim();
      if (!part || gen !== speakGen) break;
      await speakCloud(part, gen);
    }
    speaking = false;
    if (speakerBtn) speakerBtn.classList.remove("speaking");
    var finished = gen === speakGen;
    if (finished){
      if (lastAskVoice && !locked) resumeListenAfterSpeak(gen);
      else setVoiceLine(null);
    }
    return finished;
  }

  function stopListening(sendIt){
    recSession += 1;
    listenActive = false;
    setTalkRec(false);
    var said = pendingTranscript.trim();
    if (rec){
      try { rec.onresult = null; rec.onerror = null; rec.onend = null; rec.stop(); } catch (e) {}
      rec = null;
      lastRecEnd = Date.now();
    }
    pendingTranscript = "";
    if (sendIt && said) ask(said, true);
    else if (!sendIt) setVoiceLine(null);
  }
  function startListening(){
    if (!SR || busy || locked) return;
    if (!intakeSent && !validateIntake()) return;
    recSession += 1;
    var session = recSession;
    stopSpeaking();
    if (rec){
      try { rec.onend = null; rec.stop(); } catch (e) {}
      rec = null;
    }
    pendingTranscript = "";
    listenActive = true;
    setTalkRec(true);
    openThread();
    setVoiceLine("listening", "Listening — tap Send when you're done");
    var wait = Math.max(0, 400 - (Date.now() - lastRecEnd));
    setTimeout(function(){
      if (session !== recSession) return;
      try {
        rec = new SR();
        rec.lang = "en-US";
        rec.interimResults = true;
        rec.continuous = true;
        rec.onresult = function(ev){
          var t = "";
          for (var i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript;
          pendingTranscript = t.trim();
          q.value = pendingTranscript;
          autosize(q);
        };
        rec.onerror = function(ev){
          if (ev && (ev.error === "not-allowed" || ev.error === "service-not-allowed")){
            setVoiceLine(null);
            setTalkRec(false);
            listenActive = false;
          }
        };
        rec.onend = function(){
          lastRecEnd = Date.now();
          rec = null;
          if (session !== recSession) return;
          // Unexpected end: keep any transcript in the box; only an explicit second tap sends.
          listenActive = false;
          setTalkRec(false);
          setVoiceLine(null);
        };
        rec.start();
      } catch (e) {
        listenActive = false;
        setTalkRec(false);
        setVoiceLine(null);
      }
    }, wait);
  }
  function toggleTalk(){
    if (locked) return;
    if (listenActive){ stopListening(true); return; }
    requireAccountForIntake().then(function(ok){
      if (!ok) return;
      if (speaking) stopSpeaking();
      startListening();
    });
  }
  talkBtns.forEach(function(b){ b.addEventListener("click", toggleTalk); });

  function esc(s){ return s.replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  function fmt(text){
    var lines = esc(text).split(/\n/);
    var out = "", inList = false, para = [];
    function flush(){ if (para.length){ out += "<p>" + para.join("<br>") + "</p>"; para = []; } }
    lines.forEach(function(l){
      var t = l.trim();
      var m = t.match(/^[-*]\s+(.*)/);
      if (m){ flush(); if (!inList){ out += "<ul>"; inList = true; } out += "<li>" + m[1] + "</li>"; return; }
      if (inList){ out += "</ul>"; inList = false; }
      if (!t){ flush(); return; }
      para.push(t);
    });
    flush(); if (inList) out += "</ul>";
    return out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }
  function autosize(el){
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  }
  q.addEventListener("input", function(){ autosize(q); }); autosize(q);
  qIdle.addEventListener("input", function(){ autosize(qIdle); }); autosize(qIdle);
  function bindEnter(el, f){
    el.addEventListener("keydown", function(e){
      if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); f(); }
    });
  }
  bindEnter(q, function(){ form.requestSubmit ? form.requestSubmit() : submit(); });
  bindEnter(qIdle, function(){ formIdle.requestSubmit ? formIdle.requestSubmit() : submitIdle(); });

  function scrollDown(){ msgsEl.scrollTop = msgsEl.scrollHeight; }
  function openThread(){
    if (chatShell) chatShell.classList.add("on");
    if (idleStart) idleStart.classList.add("hide");
    var intro = document.getElementById("introVideo");
    if (intro && !intro.paused){ try{ intro.pause(); }catch(e){} }
  }
  // Tap-to-answer: Spry may end a question with [OPTIONS: a | b] (tap one, sends at once)
  // or [CHECK: a | b | c] (tap all that apply, then Send). The token never shows as text.
  var OPT_RE = /\s*\[(OPTIONS|CHECK)\s*:\s*([^\]]*)\]\s*/gi;
  function stripOpts(text){
    return String(text || "").replace(OPT_RE, "\n").replace(/\s*\[(?:OPTIONS|CHECK)\b[^\]]*$/i, "").trim();
  }
  function parseOpts(text){
    var m, last = null, re = new RegExp(OPT_RE.source, "gi");
    while ((m = re.exec(String(text || "")))) last = m;
    if (!last) return null;
    var seen = {}, items = [];
    last[2].split("|").forEach(function(s){
      s = s.replace(/[*_`<>]/g, "").trim().slice(0, 60);
      var k = s.toLowerCase();
      if (s && !seen[k] && items.length < 8){ seen[k] = 1; items.push(s); }
    });
    if (!items.length) return null;
    return { multi: last[1].toUpperCase() === "CHECK" && items.length > 1, items: items };
  }
  function clearQuick(){
    var old = msgsEl.querySelectorAll(".quick");
    for (var i = 0; i < old.length; i++) old[i].remove();
  }
  function renderQuick(o){
    clearQuick();
    if (!o || locked) return false;
    var box = document.createElement("div");
    box.className = "quick";
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", o.multi ? "Tap all that apply, then Send" : "Tap an answer");
    function mk(label, cls){
      var b = document.createElement("button");
      b.type = "button"; b.className = "qbtn" + (cls ? " " + cls : ""); b.textContent = label;
      box.appendChild(b); return b;
    }
    if (!o.multi){
      o.items.forEach(function(label){
        mk(label).addEventListener("click", function(){ ask(label); });
      });
    } else {
      var hint = document.createElement("p");
      hint.className = "quick-hint"; hint.textContent = "Tap all that apply, then Send.";
      box.appendChild(hint);
      var picks = [];
      o.items.forEach(function(label){
        var b = mk(label); b.setAttribute("aria-pressed", "false");
        b.addEventListener("click", function(){
          var on = b.getAttribute("aria-pressed") !== "true";
          b.setAttribute("aria-pressed", on ? "true" : "false");
          picks = on ? picks.concat(label) : picks.filter(function(x){ return x !== label; });
          send.disabled = !picks.length;
        });
      });
      mk("None of these", "qnone").addEventListener("click", function(){ ask("None of these"); });
      var send = mk("Send", "qsend"); send.disabled = true;
      send.addEventListener("click", function(){ if (picks.length) ask(picks.join(", ")); });
    }
    msgsEl.appendChild(box); scrollDown();
    return true;
  }
  // Each bubble: a visually hidden speaker label + the message body. Streaming writes to
  // .msg-body only, so the label survives and screen readers know who said what.
  function addMsg(role, html){
    var d = document.createElement("div");
    d.className = "msg " + (role === "user" ? "u" : "a");
    var who = document.createElement("span");
    who.className = "sr";
    who.textContent = role === "user" ? "You said: " : "Spry said: ";
    var body = document.createElement("div");
    body.className = "msg-body";
    body.innerHTML = html;
    d.appendChild(who); d.appendChild(body);
    msgsEl.appendChild(d); scrollDown(); return d;
  }
  function msgBody(bubble){ return (bubble && bubble.querySelector(".msg-body")) || bubble; }
  // One polite announcement per event (finished reply, error, next-step card). The log itself
  // is aria-live="off" so a streamed reply is not read out chunk by chunk.
  var srLive = document.getElementById("srLive");
  var srLiveTimer = null;
  function announce(text){
    if (!srLive) return;
    var t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return;
    if (t.length > 1200) t = t.slice(0, 1200) + "…";
    srLive.textContent = "";
    if (srLiveTimer) clearTimeout(srLiveTimer);
    srLiveTimer = setTimeout(function(){ srLive.textContent = t; }, 60);
  }
  function focusCard(el){
    if (!el) return;
    el.tabIndex = -1;
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
  }
  function emergencyCard(opts){
    opts = opts || {};
    var crisis = !!opts.crisis;
    var body = String(opts.body || "").trim();
    var d = document.createElement("div");
    d.className = "emerg"; d.setAttribute("role", "alert");
    var title = crisis && !opts.medical
      ? "Please get crisis help now."
      : "This needs emergency care now.";
    var p = body;
    if (!p){
      if (crisis && !opts.medical){
        p = "You mentioned thoughts of harming yourself or others. Call or text 988 (Suicide &amp; Crisis Lifeline) now. If you are in immediate danger, call 911. Do not wait for an online visit.";
      } else {
        p = esc(opts.reason || "What you described needs emergency care now.") +
          " Please call 911 or go to the nearest emergency room. Do not wait for an online visit." +
          (crisis ? " Because you also mentioned thoughts of harming yourself or others, call or text 988 as well." : "");
      }
    }
    var actions = crisis && !opts.medical
      ? '<div class="row"><a class="btn btn-red" href="tel:988">Call or text 988</a><a class="btn btn-ghost" href="tel:911">Call 911</a></div>'
      : (crisis
        ? '<div class="row"><a class="btn btn-red" href="tel:911">Call 911</a><a class="btn btn-ghost" href="tel:988">Call or text 988</a></div>'
        : '<div class="row"><a class="btn btn-red" href="tel:911">Call 911</a><a class="btn btn-ghost" href="https://www.google.com/maps/search/emergency+room+near+me" target="_blank" rel="noopener">Find nearest ER</a></div>');
    d.innerHTML = '<span class="mono" style="color:var(--red2)">Spry | Safety check</span>' +
      "<h2>" + title + "</h2>" +
      "<p>" + p + "</p>" +
      actions;
    msgsEl.appendChild(d); scrollDown();
    track("emergency_shown", {});
    // The composer is about to be hidden; land keyboard focus on the alert so the 911/988 links are next.
    focusCard(d);
  }
  // Marks the message where Spry lands on the most likely problem (may differ from the pathway clicked).
  function synopsisLabel(bubble){
    if (!bubble) return;
    var tag = document.createElement("span");
    tag.className = "mono";
    tag.style.cssText = "display:block;color:var(--acc);margin-bottom:6px";
    tag.textContent = "Summary for your physician — not a diagnosis";
    bubble.insertBefore(tag, msgBody(bubble));
    scrollDown();
  }
  async function membershipSnapshot(){
    try {
      var headers = await authHeaders();
      if (!headers.Authorization) return null;
      var r = await fetch("/api/member?scope=benefits", { headers: headers });
      if (!r.ok) return null;
      var data = await r.json();
      return data && data.membership ? data.membership : null;
    } catch (e) { return null; }
  }
  function memberCard(summary){
    educationSummary = String(summary || "").replace(/\s*\[(MEMBER|READY|EMERGENCY|SYNOPSIS)\]\s*/gi, "\n").trim();
    // The synopsis is the clinically useful part for the chart; send it ahead of the education wrap-up.
    if (synopsisText) educationSummary = "Synopsis:\n" + synopsisText + "\n\n" + educationSummary;
    var pathId = activePathway && activePathway.conditionId;
    var d = document.createElement("div");
    d.className = "member-card";
    d.innerHTML =
      '<span class="mono" style="color:var(--acc)">Intake ready</span>' +
      "<h2>How do you want to be seen?</h2>" +
      "<p>Checking your membership…</p>";
    msgsEl.appendChild(d); scrollDown();
    function askMore(){
      var more = document.createElement("button");
      more.className = "btn btn-ghost";
      more.type = "button";
      more.textContent = "Ask Spry something else";
      more.addEventListener("click", function(){
        unlockIntake();
        try { q.focus(); } catch (e) {}
      });
      return more;
    }
    membershipSnapshot().then(function(mem){
      var included = mem && mem.benefits === true;
      var knownOff = mem && mem.benefits === false && mem.status && mem.status !== "unknown";
      var p = d.querySelector("p");
      var actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:10px;flex-wrap:wrap";
      if (included) {
        if (p) p.textContent = "Your membership is active, so this visit is included. We'll file Spry's synopsis to your physician. There's no new charge.";
        var inc = document.createElement("button");
        inc.className = "btn";
        inc.type = "button";
        inc.textContent = "File this visit · included";
        inc.addEventListener("click", function(){
          d.remove();
          handoffCard(educationSummary, { after: "book", included: true, pathway: pathId });
        });
        actions.appendChild(inc);
      } else {
        if (p) p.textContent = knownOff
          ? "Your membership isn't active, so this visit isn't included. Pay $49 for this visit, or resubscribe for $100 a month. Payment opens after this chart step."
          : "Next we file a summary of what you told Spry to your physician's chart, then you pay securely. A one-time visit is $49 for this problem. Membership is $100 a month for up to 3 visits.";
        track("paywall_shown", {});
        var visitBtn = document.createElement("button");
        visitBtn.className = "btn";
        visitBtn.type = "button";
        visitBtn.textContent = "One visit · $49";
        visitBtn.addEventListener("click", function(){
          d.remove();
          handoffCard(educationSummary, { after: "pay", plan: "visit", pathway: pathId });
        });
        var joinBtn = document.createElement("button");
        joinBtn.className = "btn btn-ghost";
        joinBtn.type = "button";
        joinBtn.textContent = knownOff ? "Resubscribe · $100/month" : "Become a member · $100/month";
        joinBtn.addEventListener("click", function(){
          d.remove();
          handoffCard(educationSummary, { after: "pay", plan: "membership", pathway: pathId });
        });
        if (storedOffer() === "membership") {
          actions.appendChild(joinBtn);
          actions.appendChild(visitBtn);
        } else {
          actions.appendChild(visitBtn);
          actions.appendChild(joinBtn);
        }
      }
      actions.appendChild(askMore());
      d.appendChild(actions);
    });
  }
  function handoffCard(summary, opts){
    opts = opts || {};
    var afterHint = opts.after === "pay";
    var included = opts.included === true && !afterHint;
    var plan = opts.plan === "visit" ? "visit" : "membership";
    var pathwayId = opts.pathway || (activePathway && activePathway.conditionId) || "";
    var clean = summary.replace(/\s*\[(READY|EMERGENCY|MEMBER)\]\s*/gi, "\n").trim();
    if (pathwayId){
      clean = "Pathway: " + pathwayId + "\n\n" + clean;
    }
    var acct = window.IspryAccount ? window.IspryAccount.get() : null;
    var f = document.createElement("form");
    f.className = "handoff"; f.setAttribute("autocomplete", "on"); f.noValidate = false;
    f.innerHTML =
      '<span class="mono">' + (included ? "Included member visit" : (afterHint ? (plan === "visit" ? "One-time visit · $49" : "Membership · $100/month") : "Intake complete")) + "</span>" +
      "<h2>" + (included ? "File this visit to your chart" : (afterHint ? "File to your chart, then pay" : "Your chart takes it from here")) + "</h2>" +
      '<p class="note" style="margin:0">' +
        (included
          ? "This visit is included in your membership. Your name and Spry's synopsis go to your physician, not back into the AI. There's no new charge. Next: demographics and preferred pharmacy, then book the visit."
          : (afterHint
          ? (plan === "visit"
            ? "Your name and contact go to your physician's chart with a summary of what you told Spry — not back into the AI. Then Stripe opens for the $49 visit. You can upgrade to membership later. Published prices are on the Good Faith Estimate page."
            : "Your name and contact go to your physician's chart with a summary of what you told Spry — not back into the AI. Then Stripe opens for the $100/month membership. Published prices are on the Good Faith Estimate page.")
          : "Spry is done. Your name and contact go to your medical record, not to the AI. Next: demographics and preferred pharmacy so prescriptions can be sent, then book the visit.")) +
      '</p><p class="note" style="margin:0"><a href="/good-faith-estimate.html" target="_blank" rel="noopener">Good Faith Estimate of published prices</a></p>' +
      '<div class="grid2">' +
        '<label class="f">First name<input type="text" name="first_name" autocomplete="given-name" required maxlength="60"></label>' +
        '<label class="f">Last name<input type="text" name="last_name" autocomplete="family-name" required maxlength="60"></label>' +
        '<label class="f">Date of birth<input type="date" name="date_of_birth" autocomplete="bday" required></label>' +
        '<label class="f">Sex<select name="sex" required><option value="">Select</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select></label>' +
        '<label class="f">Email<input type="email" name="email" autocomplete="email" required maxlength="120"></label>' +
        '<label class="f">Mobile phone<input type="tel" name="phone" autocomplete="tel-national" required pattern="[0-9()\\-\\s.+]{10,16}"></label>' +
      '</div>' +
      '<label class="hp" aria-hidden="true">Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label>' +
      '<label class="chk"><input type="checkbox" name="in_tennessee" required><span>I will be physically located in Tennessee during my visit.</span></label>' +
      '<label class="chk"><input type="checkbox" name="consent" required><span>I have read the <a href="/telehealth-consent.html" target="_blank" rel="noopener">telehealth informed consent</a> and consent to receive care by telehealth from William B. Merrick, DO, PLLC (iSpry). I have also read the <a href="/terms.html" target="_blank" rel="noopener">terms</a> and the <a href="/npp.html" target="_blank" rel="noopener">Notice of Privacy Practices</a>, and I understand iSpry is not for emergencies.</span></label>' +
      '<label class="chk"><input type="checkbox" name="sms_opt_in"><span>Optional: I agree to receive appointment and care text messages from iSpry at this number. Message frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out, HELP for help. Consent is not required to receive care.</span></label>' +
      '<div class="err" role="alert" style="display:none"></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn" type="submit">' +
        (included ? "File included visit" : (afterHint ? "File to chart &amp; continue to payment" : "Continue to your chart")) +
      "</button></div>";
    var errEl = f.querySelector(".err");
    if (acct){
      if (acct.first_name) f.first_name.value = acct.first_name;
      if (acct.last_name) f.last_name.value = acct.last_name;
      if (acct.email) f.email.value = acct.email;
      if (acct.sex) f.sex.value = acct.sex;
      if (acct.in_tennessee) f.in_tennessee.checked = true;
    }
    f.addEventListener("submit", async function(e){
      e.preventDefault();
      errEl.style.display = "none";
      var fd = new FormData(f), btn = f.querySelector("button[type=submit]");
      var body = {
        first_name: fd.get("first_name"), last_name: fd.get("last_name"), date_of_birth: fd.get("date_of_birth"),
        sex: fd.get("sex"), email: fd.get("email"), phone: fd.get("phone"), website: fd.get("website"),
        in_tennessee: !!fd.get("in_tennessee"), consent: !!fd.get("consent"), sms_opt_in: !!fd.get("sms_opt_in"),
        summary: clean,
        pathway: pathwayId || undefined,
        after: afterHint ? "pay" : "book",
        plan: afterHint ? plan : undefined
      };
      btn.disabled = true; btn.textContent = "Sending…";
      track("handoff_submit", { after: afterHint ? "pay" : "book" });
      try {
        var r = await fetch("/api/handoff", { method: "POST", headers: await authHeaders(), body: JSON.stringify(body) });
        var j = await r.json().catch(function(){ return {}; });
        if (r.status === 401) {
          throw new Error("Please sign in to file this to your chart.");
        }
        if (r.status === 429 && j.error === "daily_limit") {
          throw new Error("You've reached today's limit for filing a visit. If this is urgent, call 911.");
        }
        if (r.status === 503 && j.error === "not_configured") {
          throw new Error("Chart filing isn't connected yet, so this visit can't be sent. Please try again shortly.");
        }
        if (r.status === 402 && j.code === "membership_inactive") {
          btn.disabled = false;
          btn.hidden = true;
          errEl.textContent = "";
          var note = document.createElement("p");
          note.style.margin = "0 0 10px";
          note.textContent = j.error || "Your membership isn't active, so this visit isn't included.";
          var row = document.createElement("div");
          row.style.cssText = "display:flex;gap:10px;flex-wrap:wrap";
          function repay(nextPlan, label){
            var b = document.createElement("button");
            b.type = "button";
            b.className = nextPlan === "visit" ? "btn" : "btn btn-ghost";
            b.textContent = label;
            b.addEventListener("click", function(){
              errEl.style.display = "none";
              btn.hidden = false;
              afterHint = true;
              included = false;
              plan = nextPlan;
              var heading = f.querySelector("h2");
              if (heading) heading.textContent = "File to your chart, then pay";
              var kicker = f.querySelector(".mono");
              if (kicker) kicker.textContent = nextPlan === "visit" ? "One-time visit · $49" : "Membership · $100/month";
              f.requestSubmit();
            });
            return b;
          }
          row.appendChild(repay("visit", "Pay $49 for this visit"));
          row.appendChild(repay("membership", "Resubscribe · $100/month"));
          errEl.appendChild(note);
          errEl.appendChild(row);
          errEl.style.display = "block";
          return;
        }
        if (!r.ok) throw new Error(j.error || "Something went wrong. Please try again.");
        track("handoff_ok", { after: afterHint ? "pay" : "book" });
        try { sessionStorage.setItem("ispry_consent_ok", "1"); } catch (e) {}
        // Which Akute forms bundle this visit needs, so My care opens the same one after payment.
        try {
          if (/^[a-z-]{1,20}$/.test(String(j.forms_kind || ""))) sessionStorage.setItem("ispry_forms_kind", j.forms_kind);
          else sessionStorage.removeItem("ispry_forms_kind");
        } catch (e) { /* private mode / blocked storage */ }
        var done = document.createElement("div");
        done.className = "ready";
        var forms = safeHttpsUrl(j.forms_url);
        var book = safeHttpsUrl(j.booking_url);
        // Prefer forms (demographics + pharmacy) as the first follow-through; fall back to booking.
        var primary = forms || book;
        var hintPay = stripeHosted(j.checkout_url) || (afterHint && plan !== "visit" ? pathwaySignupUrl() : "");
        var overCap = j.over_cap
          ? 'Note: you\'ve reached this month\'s 3-visit limit, so our office will contact you about timing. '
          : '';
        if (afterHint && hintPay) {
          if (window.IspryAccount) window.IspryAccount.setPendingPathway(null);
          rememberCheckout(plan);
          done.innerHTML = '<p><strong style="color:var(--tx)">Filed to your chart.</strong> ' +
            overCap +
            (plan === "visit"
              ? "Opening secure checkout for your $49 visit…"
              : "Opening secure checkout for membership payment…") +
            '</p>' +
            '<a class="btn" href="' + esc(hintPay) + '" rel="noopener">Continue to payment</a>';
          f.replaceWith(done); scrollDown();
          var skipAuto = false;
          try {
            var prevAt = Number(sessionStorage.getItem("ispry_checkout_redirect_at") || 0);
            if (prevAt && (Date.now() - prevAt) < 60000) skipAuto = true;
            else sessionStorage.setItem("ispry_checkout_redirect_at", String(Date.now()));
          } catch (e) { /* private mode / blocked storage */ }
          if (!skipAuto) {
            if (akuteRedirectTimer) clearTimeout(akuteRedirectTimer);
            akuteRedirectTimer = setTimeout(function(){
              akuteRedirectTimer = null;
              window.location.replace(hintPay);
            }, 1200);
          }
        } else if (afterHint && plan === "visit") {
          if (window.IspryAccount) window.IspryAccount.setPendingPathway(null);
          done.innerHTML = '<p><strong style="color:var(--tx)">Filed to your chart.</strong> ' +
            overCap +
            'The $49 visit checkout is not connected yet, so the office will contact you to collect that fee. You can also upgrade to membership now.</p>' +
            '<a class="btn js-join-direct" href="' + esc(CHECKOUT_URL) + '">Upgrade to membership · $100/month</a>';
          f.replaceWith(done); scrollDown();
        } else if (primary) {
          var steps =
            'Complete your demographics and preferred pharmacy so prescriptions can be sent' +
            (book ? ', then book your visit' : '') + '.';
          var openLabel = forms
            ? 'Opening demographics and pharmacy…'
            : 'Opening scheduling…';
          var btns = '<a class="btn" href="' + esc(primary) + '" rel="noopener">' +
            (forms ? 'Complete demographics &amp; pharmacy' : 'Continue to your chart') + '</a>';
          if (forms && book && forms !== book) {
            btns += '<a class="btn btn-ghost" href="' + esc(book) + '" rel="noopener">Book your visit</a>';
          }
          done.innerHTML = '<p><strong style="color:var(--tx)">Sent to your chart.</strong> ' +
            overCap + steps + ' ' + openLabel + '</p>' + btns;
          f.replaceWith(done); scrollDown();
          // replace() so Back from Akute does not return to this interstitial.
          // One-shot guard + clear on pagehide stop a second timed redirect
          // if the success page is restored from history/bfcache.
          var skipBook = false;
          try {
            var prevBook = Number(sessionStorage.getItem("ispry_akute_redirect_at") || 0);
            if (prevBook && (Date.now() - prevBook) < 60000) skipBook = true;
            else sessionStorage.setItem("ispry_akute_redirect_at", String(Date.now()));
          } catch (e) { /* private mode / blocked storage */ }
          if (!skipBook) {
            if (akuteRedirectTimer) clearTimeout(akuteRedirectTimer);
            akuteRedirectTimer = setTimeout(function(){
              akuteRedirectTimer = null;
              window.location.replace(primary);
            }, 1200);
          }
        } else {
          done.innerHTML = '<p><strong style="color:var(--tx)">Sent to your chart.</strong> ' +
            overCap +
            'Dr. Merrick has your intake. The follow-through link is not available yet, so the office will help you finish demographics, pharmacy, and scheduling.</p>';
          f.replaceWith(done); scrollDown();
        }
      } catch (ex) {
        errEl.textContent = ex.message; errEl.style.display = "block";
        btn.disabled = false; btn.textContent = afterHint ? "File to chart & continue to payment" : "Continue to your chart";
      }
    });
    msgsEl.appendChild(f);
    // Show the form from its top (heading + what-goes-where note) rather than its submit button.
    try { msgsEl.scrollTop += f.getBoundingClientRect().top - msgsEl.getBoundingClientRect().top - 6; } catch (e) { scrollDown(); }
    lockIntake();
    // lockIntake() hides the composer the patient was using; move focus to the form's heading so
    // keyboard and screen-reader users start at the explanation, then Tab into the fields.
    focusCard(f.querySelector("h2"));
  }

  function hasAccount(){
    var p = window.IspryAccount && window.IspryAccount.get();
    return !!(p && p.first_name);
  }
  function messagesForApi(){
    var basicsIdx = -1;
    for (var i = 0; i < history.length; i++) {
      if (history[i].role === "user" && /Visit basics/.test(history[i].content)) basicsIdx = i;
    }
    var tail = history.slice(-16);
    if (basicsIdx >= 0 && tail.indexOf(history[basicsIdx]) === -1) {
      tail = [history[basicsIdx]].concat(tail.slice(-15));
    }
    return tail;
  }
  async function ask(text, fromVoice, opts){
    opts = opts || {};
    text = (text || "").trim();
    if (!text || busy || locked) return;
    clearQuick();
    if (isEmergency(text)){
      lastAskVoice = !!fromVoice;
      if (listenActive) stopListening(false);
      stopSpeaking();
      openThread();
      addMsg("user", fmt(text));
      var crisisHitEarly = isCrisis(text);
      var medicalHitEarly = matchFlags(MEDICAL_EMERGENCY_RE, text).length > 0;
      var reasonEarly = medicalReasonFromText(text);
      emergencyCard({ crisis: crisisHitEarly, medical: medicalHitEarly, reason: reasonEarly });
      var spokenEarly = crisisHitEarly && !medicalHitEarly
        ? "Please call or text nine eight eight now. If you are in immediate danger, call nine one one."
        : reasonEarly + " Please call nine one one or go to the nearest emergency room now." +
          (crisisHitEarly ? " Also call or text nine eight eight." : "");
      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: "[EMERGENCY] " + spokenEarly });
      lockIntake();
      speakReply(spokenEarly);
      q.value = ""; autosize(q);
      qIdle.value = ""; autosize(qIdle);
      return;
    }
    if (!(await requireAccountForIntake())){
      pendingAskText = text;
      if (qIdle && !qIdle.value.trim()) { qIdle.value = text; autosize(qIdle); }
      if (q && !q.value.trim()) { q.value = text; autosize(q); }
      return;
    }
    if (pendingAskText === text) pendingAskText = "";
    if (!intakeSent && !validateIntake()) return;
    lastAskVoice = !!fromVoice;
    if (listenActive) stopListening(false);
    stopSpeaking();
    openThread();
    var sendText = text;
    if (!intakeSent){
      sendText = intakeLine() + "\n\n" + text;
      intakeSent = true;
    }
    // Pathway kickoff is system-driven; show a short patient-facing line in the thread.
    // Visit basics stay in the API payload only — never dump them into the chat bubble.
    if (opts.pathwayKickoff){
      addMsg("user", fmt("I chose: " + (opts.pathLabel || "this pathway") + ". Let's get started."));
    } else {
      addMsg("user", fmt(text));
    }
    if (!chatStarted) { chatStarted = true; track("chat_start", {}); }
    history.push({ role: "user", content: sendText });
    q.value = ""; autosize(q);
    qIdle.value = ""; autosize(qIdle);

    busy = true;
    setComposerEnabled(false);
    setVoiceLine(null);
    var bubble = addMsg("assistant", '<span class="typing" role="img" aria-label="Spry is typing"><i></i><i></i><i></i></span>');
    var bubbleBody = msgBody(bubble);
    announce("Spry is replying.");
    var full = "";
    try {
      var payload = { messages: messagesForApi() };
      if (window.IspryAccount && window.IspryAccount.turnstileEnabled && window.IspryAccount.turnstileEnabled()) {
        var ts = await window.IspryAccount.turnstileToken();
        if (!ts) throw new Error("bot");
        payload.turnstile_token = ts;
      }
      var r = await fetch("/api/spry", { method: "POST", headers: await authHeaders(), body: JSON.stringify(payload) });
      if (r.status === 401) throw new Error("auth");
      if (r.status === 403) throw new Error("bot");
      if (r.status === 503) throw new Error("account_check");
      if (r.status === 429) {
        var lim = {};
        try { lim = await r.json(); } catch (e2) {}
        throw new Error(lim.error === "daily_limit" ? "daily" : "rate");
      }
      if (!r.ok || !r.body) throw new Error("bad");
      var reader = r.body.getReader(), dec = new TextDecoder();
      while (true){
        var x = await reader.read(); if (x.done) break;
        full += dec.decode(x.value, { stream: true });
        var shown = stripOpts(full.replace(/\s*\[(EMERGENCY|READY|MEMBER|SYNOPSIS)\]\s*/gi, "\n"));
        if (shown) bubbleBody.innerHTML = fmt(shown);
        scrollDown();
      }
      if (!full.trim()) throw new Error("empty");
      history.push({ role: "assistant", content: full });
      // Keep the options token in history (so Spry stays consistent) but out of everything
      // the patient reads, hears, or that is filed to the chart.
      var quick = parseOpts(full);
      var quickShown = false;
      full = stripOpts(full);
      // Control tokens are supposed to lead the reply, but the model sometimes puts a
      // greeting first or drops the token entirely. Detect them anywhere, and in pathway
      // mode fall back to the wrap-up's required "Problem:" line so a patient is never
      // left at "Ready to get started?" with no button.
      var inPathway = !!activePathway;
      var wrapUpLine = /^\s*(?:[-*•]\s*|\d+[.)]\s*)?(?:\*\*|__)?Problem:/mi.test(full);
      var synopsisLike = /^\s*(?:[-*•]\s*|\d+[.)]\s*)?(?:\*\*|__)?Most likely\b/mi.test(full) && !synopsisText;
      if (/\[EMERGENCY\]/i.test(full)){
        var emergBody = full.replace(/^\s*\[EMERGENCY\]\s*/i, "").replace(/\s*\[EMERGENCY\]\s*/gi, "\n").trim();
        var userBlob = history.filter(function(m){ return m.role === "user"; }).map(function(m){ return m.content; }).join("\n");
        // 988 only when the patient expresses suicide/homicide risk — never from bot copy alone.
        var crisisFromUser = isCrisis(userBlob);
        var medicalFromUser = matchFlags(MEDICAL_EMERGENCY_RE, userBlob).length > 0;
        var medicalFromReply = /911|emergency room|\bER\b|airway|breath|chest|stroke|bleed|seizure|overdose/i.test(emergBody);
        bubble.remove();
        emergencyCard({
          body: esc(emergBody).replace(/\n+/g, "<br>"),
          crisis: crisisFromUser,
          medical: medicalFromUser || medicalFromReply || !crisisFromUser
        });
        lockIntake();
      }
      else if (/\[MEMBER\]/i.test(full) || (inPathway && wrapUpLine)){
        memberCard(full);
        announce("Spry said: " + bubbleBody.textContent + " Choose a one-time visit or membership.");
      }
      else if (/\[READY\]/i.test(full)){
        // Same pay fork as pathway wrap-up: $49 visit or membership, then chart + Stripe.
        var readyForChart = full;
        if (synopsisText) readyForChart = "Synopsis:\n" + synopsisText + "\n\n" + full;
        memberCard(readyForChart);
        announce("Spry said: " + bubbleBody.textContent + " Choose a one-time visit or membership.");
      }
      else if (/\[SYNOPSIS\]/i.test(full) || (inPathway && synopsisLike)){
        synopsisText = full.replace(/\s*\[SYNOPSIS\]\s*/gi, "").trim();
        synopsisLabel(bubble);
        quickShown = renderQuick(quick);
        announce("Summary for your physician, not a diagnosis: " + bubbleBody.textContent + (quickShown ? " Answers you can tap: " + quick.items.join(", ") + "." : ""));
      }
      else if (/We cannot continue this intake\./i.test(full)){
        // Server eligibility gate refused — stop further chat until Start over.
        lockIntake();
        announce("Spry said: " + bubbleBody.textContent + " Use Start over to begin again.");
      }
      else {
        quickShown = renderQuick(quick);
        announce("Spry said: " + bubbleBody.textContent + (quickShown ? " Answers you can tap: " + quick.items.join(", ") + "." : ""));
      }
      if (voiceReplies) speakReply(full);
    } catch (e) {
      var errMsg = "Spry couldn't respond just now. Please try again in a moment. If this is urgent, call 911.";
      if (e && e.message === "rate") errMsg = "Spry is getting a lot of requests right now. Please wait a moment and try again. If this is urgent, call 911.";
      else if (e && e.message === "daily") errMsg = "You've reached today's limit for Spry. If this is urgent, call 911.";
      else if (e && e.message === "account_check") errMsg = "Spry couldn't check your account just now. Please try again in a moment.";
      else if (e && e.message === "auth") {
        errMsg = "Please sign in to talk with Spry.";
        ensureAccount({ mode: "signin" }).catch(function(){});
      } else if (e && e.message === "bot") errMsg = "Couldn't confirm you're a person. Please try again.";
      bubbleBody.innerHTML = '<span class="err">' + errMsg + "</span>";
      announce(errMsg);
      history.pop();
      if (history.length === 0) intakeSent = false;
    } finally {
      if (!locked){
        busy = false;
        setComposerEnabled(true);
        // With tap answers showing, leave the keyboard down so it does not cover them.
        if (!speaking && !msgsEl.querySelector(".quick")) q.focus();
      }
    }
  }
  function submit(){ ask(q.value); }
  function submitIdle(){ ask(qIdle.value); }
  form.addEventListener("submit", function(e){ e.preventDefault(); submit(); });
  formIdle.addEventListener("submit", function(e){ e.preventDefault(); submitIdle(); });
    if (chips) chips.addEventListener("click", function(e){
      var b = e.target.closest(".chip");
      if (!b) return;
      chips.querySelectorAll(".chip").forEach(function(c){
        var on = c === b;
        c.setAttribute("aria-pressed", on ? "true" : "false");
        c.classList.toggle("on", on);
      });
      var topic = b.getAttribute("data-topic") || "";
      if (topic && Object.prototype.hasOwnProperty.call(TOPICS, topic)) track("topic", { topic: topic });
      ask(b.getAttribute("data-q"));
    });
  document.getElementById("reset").addEventListener("click", function(){
    stopSpeaking();
    stopListening(false);
    history = []; msgsEl.innerHTML = "";
    resetIntakeFields();
    unlockIntake();
    activePathway = null;
    educationSummary = "";
    synopsisText = "";
    if (window.IspryAccount) window.IspryAccount.setPendingPathway(null);
    try { resetPath(); } catch (e) {}
    if (chatShell) chatShell.classList.remove("on");
    if (idleStart) idleStart.classList.remove("hide");
    syncAccountUi(window.IspryAccount ? window.IspryAccount.get() : null);
    qIdle.focus();
  });

  // Fast-track pathways UI removed — keep stubs so reset/handoff stay safe.
  function resetPath(){}
  function upgradePathwayKickoff(){}
  if (window.IspryAccount) {
    try { window.IspryAccount.setPendingPathway(null); } catch (e) {}
  }

  // Section reveal on scroll (skipped when reduced motion)
  (function(){
    var nodes = document.querySelectorAll(".reveal");
    if (!nodes.length) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches){
      nodes.forEach(function(n){ n.classList.add("in"); });
      return;
    }
    if (!("IntersectionObserver" in window)){
      nodes.forEach(function(n){ n.classList.add("in"); });
      return;
    }
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if (!en.isIntersecting) return;
        en.target.classList.add("in");
        io.unobserve(en.target);
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    nodes.forEach(function(n){ io.observe(n); });
  })();
})();
