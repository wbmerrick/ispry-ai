// iSpry.ai — account gate (email OTP via Supabase + local profile fallback).
// Profile fields: first_name, last_name, email, age, sex, in_tennessee.
// Education chat is NOT stored here — only the account profile.
(function (global) {
  "use strict";

  var STORAGE_KEY = "ispry_account_v1";
  var PENDING_KEY = "ispry_pending_pathway";
  var sb = null;
  var cfg = null;
  var profile = null;
  var onReady = [];
  var modalEl = null;

  function loadLocal() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || !p.email || !p.first_name) return null;
      return p;
    } catch (e) {
      return null;
    }
  }
  function saveLocal(p) {
    profile = p;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    } catch (e) { /* private mode */ }
  }
  function clearLocal() {
    profile = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
  }

  function getPendingPathway() {
    try {
      var raw = sessionStorage.getItem(PENDING_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function setPendingPathway(obj) {
    try {
      if (!obj) sessionStorage.removeItem(PENDING_KEY);
      else sessionStorage.setItem(PENDING_KEY, JSON.stringify(obj));
    } catch (e) {}
  }

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement("div");
    modalEl.id = "accountModal";
    modalEl.className = "acct-modal";
    modalEl.hidden = true;
    modalEl.setAttribute("role", "dialog");
    modalEl.setAttribute("aria-modal", "true");
    modalEl.setAttribute("aria-labelledby", "acctTitle");
    modalEl.innerHTML =
      '<div class="acct-backdrop" data-acct-close="1"></div>' +
      '<div class="acct-card">' +
      '  <button type="button" class="acct-x" data-acct-close="1" aria-label="Close">×</button>' +
      '  <p class="mono acct-kicker">iSpry account</p>' +
      '  <h2 id="acctTitle">Start your account</h2>' +
      '  <p class="acct-lede" id="acctLede">Not membership yet — just enough so Spry can educate you and pick up where you left off.</p>' +
      '  <form id="acctForm" novalidate>' +
      '    <div class="acct-grid">' +
      '      <label class="f">First name<input name="first_name" autocomplete="given-name" required maxlength="60"></label>' +
      '      <label class="f">Last name<input name="last_name" autocomplete="family-name" required maxlength="60"></label>' +
      '      <label class="f acct-span2">Email<input name="email" type="email" autocomplete="email" required maxlength="120"></label>' +
      '      <label class="f">Age (years)<input name="age" type="number" inputmode="numeric" min="18" max="120" required></label>' +
      '      <label class="f">Sex<select name="sex" required><option value="">Select</option><option value="male">Male (M)</option><option value="female">Female (FM)</option></select></label>' +
      '      <label class="f acct-span2">Physically in Tennessee now?<select name="in_tennessee" required><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select></label>' +
      '      <label class="f acct-span2 acct-otp" id="acctOtpWrap" hidden>Email code<input name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="6-digit code from email"></label>' +
      "    </div>" +
      '    <p class="acct-err" id="acctErr" role="alert" hidden></p>' +
      '    <p class="acct-note" id="acctNote"></p>' +
      '    <div class="acct-actions">' +
      '      <button class="btn" type="submit" id="acctSubmit">Continue</button>' +
      '      <button class="btn btn-ghost" type="button" id="acctModeToggle">I already have an account</button>' +
      "    </div>" +
      "  </form>" +
      "</div>";
    document.body.appendChild(modalEl);
    modalEl.addEventListener("click", function (e) {
      if (e.target && e.target.getAttribute("data-acct-close") === "1") closeModal();
    });
    document.getElementById("acctModeToggle").addEventListener("click", function () {
      state.mode = state.mode === "create" ? "signin" : "create";
      paintMode();
    });
    document.getElementById("acctForm").addEventListener("submit", onSubmit);
    return modalEl;
  }

  var state = {
    mode: "create", // create | signin
    phase: "profile", // profile | otp
    pendingResolve: null,
    pendingReject: null,
    otpEmail: "",
  };

  function paintMode() {
    ensureModal();
    var title = document.getElementById("acctTitle");
    var lede = document.getElementById("acctLede");
    var toggle = document.getElementById("acctModeToggle");
    var note = document.getElementById("acctNote");
    var otpWrap = document.getElementById("acctOtpWrap");
    if (state.mode === "create") {
      title.textContent = "Start your iSpry account";
      lede.textContent =
        "Not membership yet — name, age, sex, and Tennessee so Spry can welcome you and keep going.";
      toggle.textContent = "I already have an account";
    } else {
      title.textContent = "Sign in to iSpry";
      lede.textContent = "Use the email on your account. We'll send a one-time code.";
      toggle.textContent = "Create an account instead";
    }
    if (state.phase === "otp") {
      otpWrap.hidden = false;
      note.textContent = "Check your email for a 6-digit code, then enter it here.";
      document.getElementById("acctSubmit").textContent = "Verify & continue";
    } else {
      otpWrap.hidden = true;
      note.textContent = cfg && cfg.configured
        ? "We'll email a one-time code to confirm it's you. Chat stays in this browser; your chart is in Akute after you become a member."
        : "Your account is saved in this browser for this visit. Membership payment still happens later in Hint.";
      document.getElementById("acctSubmit").textContent = "Continue";
    }
  }

  function showErr(msg) {
    var el = document.getElementById("acctErr");
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = msg;
  }

  function closeModal() {
    if (!modalEl) return;
    modalEl.hidden = true;
    document.body.classList.remove("acct-open");
    if (state.pendingReject) {
      var rej = state.pendingReject;
      state.pendingResolve = null;
      state.pendingReject = null;
      rej(new Error("cancelled"));
    }
  }

  function openModal(opts) {
    ensureModal();
    state.mode = (opts && opts.mode) || (profile ? "signin" : "create");
    state.phase = "profile";
    state.otpEmail = "";
    showErr("");
    paintMode();
    var form = document.getElementById("acctForm");
    if (form) form.reset();
    if (profile && state.mode === "signin") {
      form.email.value = profile.email || "";
    }
    if (opts && opts.prefill) {
      if (opts.prefill.first_name) form.first_name.value = opts.prefill.first_name;
      if (opts.prefill.last_name) form.last_name.value = opts.prefill.last_name;
      if (opts.prefill.email) form.email.value = opts.prefill.email;
      if (opts.prefill.age) form.age.value = opts.prefill.age;
      if (opts.prefill.sex) form.sex.value = opts.prefill.sex;
      if (opts.prefill.in_tennessee) form.in_tennessee.value = opts.prefill.in_tennessee ? "yes" : "no";
    }
    modalEl.hidden = false;
    document.body.classList.add("acct-open");
    try {
      form.first_name.focus();
    } catch (e) {}
  }

  function readForm() {
    var form = document.getElementById("acctForm");
    var first = String(form.first_name.value || "").trim().slice(0, 60);
    var last = String(form.last_name.value || "").trim().slice(0, 60);
    var email = String(form.email.value || "").trim().toLowerCase().slice(0, 120);
    var age = parseInt(String(form.age.value || "").trim(), 10);
    var sex = String(form.sex.value || "").trim();
    var loc = String(form.in_tennessee.value || "").trim();
    var otp = String(form.otp.value || "").trim();
    return { first_name: first, last_name: last, email: email, age: age, sex: sex, loc: loc, otp: otp };
  }

  function validateProfile(v, signinLite) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) return "Enter a valid email.";
    if (signinLite && state.phase === "profile") return null;
    if (!v.first_name || !v.last_name) return "Enter your first and last name.";
    if (!(v.age >= 18 && v.age <= 120)) {
      return v.age > 120 ? "Enter an age from 18 to 120." : "iSpry is for adults 18 and older.";
    }
    if (v.sex !== "male" && v.sex !== "female") return "Choose M or FM.";
    if (v.loc !== "yes" && v.loc !== "no") return "Tell us if you are in Tennessee right now.";
    if (v.loc === "no") return "iSpry care is for patients physically in Tennessee.";
    return null;
  }

  async function upsertProfileRow(userId, v) {
    if (!sb) return;
    var row = {
      id: userId,
      email: v.email,
      first_name: v.first_name,
      last_name: v.last_name,
      age: v.age,
      sex: v.sex,
      in_tennessee: v.loc === "yes",
    };
    var r = await sb.from("ispry_profiles").upsert(row, { onConflict: "id" });
    if (r.error) throw new Error(r.error.message || "Could not save profile.");
  }

  async function fetchProfileRow(userId) {
    if (!sb) return null;
    var r = await sb.from("ispry_profiles").select("*").eq("id", userId).maybeSingle();
    if (r.error || !r.data) return null;
    return {
      id: r.data.id,
      email: r.data.email,
      first_name: r.data.first_name,
      last_name: r.data.last_name,
      age: r.data.age,
      sex: r.data.sex,
      in_tennessee: !!r.data.in_tennessee,
      source: "supabase",
    };
  }

  async function sendOtp(email) {
    if (!sb) throw new Error("Auth is not ready.");
    var r = await sb.auth.signInWithOtp({
      email: email,
      options: { shouldCreateUser: true },
    });
    if (r.error) throw new Error(r.error.message || "Could not send code.");
  }

  async function verifyOtp(email, token) {
    if (!sb) throw new Error("Auth is not ready.");
    var r = await sb.auth.verifyOtp({ email: email, token: token, type: "email" });
    if (r.error) throw new Error(r.error.message || "Invalid or expired code.");
    return r.data && r.data.user;
  }

  function finishLocal(v) {
    var p = {
      email: v.email,
      first_name: v.first_name,
      last_name: v.last_name,
      age: v.age,
      sex: v.sex,
      in_tennessee: true,
      source: "local",
    };
    saveLocal(p);
    return p;
  }

  async function onSubmit(e) {
    e.preventDefault();
    showErr("");
    var v = readForm();
    var btn = document.getElementById("acctSubmit");
    btn.disabled = true;
    try {
      if (state.phase === "otp") {
        if (!/^\d{6,8}$/.test(v.otp)) throw new Error("Enter the code from your email.");
        var user = await verifyOtp(state.otpEmail || v.email, v.otp);
        if (!user) throw new Error("Could not verify that code.");
        // Prefer form profile on create; on sign-in load existing row.
        var existing = await fetchProfileRow(user.id);
        if (state.mode === "signin" && existing) {
          saveLocal(existing);
        } else {
          var err = validateProfile(v, false);
          if (err) throw new Error(err);
          await upsertProfileRow(user.id, v);
          saveLocal({
            id: user.id,
            email: v.email,
            first_name: v.first_name,
            last_name: v.last_name,
            age: v.age,
            sex: v.sex,
            in_tennessee: true,
            source: "supabase",
          });
        }
        resolveOk();
        return;
      }

      if (state.mode === "signin") {
        var e1 = validateProfile(v, true);
        if (e1) throw new Error(e1);
        if (sb && cfg && cfg.configured) {
          await sendOtp(v.email);
          state.phase = "otp";
          state.otpEmail = v.email;
          // Prefill from local cache if same email
          var local = loadLocal();
          if (local && local.email === v.email) {
            var form = document.getElementById("acctForm");
            form.first_name.value = local.first_name || "";
            form.last_name.value = local.last_name || "";
            form.age.value = local.age || "";
            form.sex.value = local.sex || "";
            form.in_tennessee.value = local.in_tennessee ? "yes" : "no";
          }
          paintMode();
          return;
        }
        // Local fallback: require matching email already on this device
        var cached = loadLocal();
        if (!cached || cached.email !== v.email) {
          throw new Error("No account on this device for that email. Create an account instead.");
        }
        saveLocal(cached);
        resolveOk();
        return;
      }

      // create
      var e2 = validateProfile(v, false);
      if (e2) throw new Error(e2);
      if (sb && cfg && cfg.configured) {
        try {
          await sendOtp(v.email);
          state.phase = "otp";
          state.otpEmail = v.email;
          paintMode();
          return;
        } catch (otpErr) {
          // Email OTP may be unavailable in this environment — keep the visit moving.
          finishLocal(v);
          resolveOk();
          return;
        }
      }
      finishLocal(v);
      resolveOk();
    } catch (ex) {
      showErr(ex.message || "Something went wrong.");
    } finally {
      btn.disabled = false;
    }
  }

  function resolveOk() {
    modalEl.hidden = true;
    document.body.classList.remove("acct-open");
    var res = state.pendingResolve;
    state.pendingResolve = null;
    state.pendingReject = null;
    notify();
    if (res) res(profile);
  }

  function notify() {
    onReady.forEach(function (fn) {
      try {
        fn(profile);
      } catch (e) {}
    });
    try {
      document.dispatchEvent(new CustomEvent("ispry:account", { detail: profile }));
    } catch (e) {}
  }

  function requireAccount(opts) {
    if (profile && profile.in_tennessee && profile.age >= 18) {
      return Promise.resolve(profile);
    }
    return new Promise(function (resolve, reject) {
      state.pendingResolve = resolve;
      state.pendingReject = reject;
      openModal(opts || {});
    });
  }

  async function init() {
    profile = loadLocal();
    ensureModal();
    try {
      var r = await fetch("/api/auth-config", { headers: { Accept: "application/json" } });
      cfg = r.ok ? await r.json() : null;
    } catch (e) {
      cfg = null;
    }
    var createClient =
      (global.supabase && global.supabase.createClient) ||
      (global.supabase && global.supabase.default && global.supabase.default.createClient) ||
      global.createClient;
    if (cfg && cfg.configured && typeof createClient === "function") {
      try {
        sb = createClient(cfg.supabase_url, cfg.anon_key, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        });
        var sess = await sb.auth.getSession();
        var user = sess && sess.data && sess.data.session && sess.data.session.user;
        if (user) {
          var row = await fetchProfileRow(user.id);
          if (row) saveLocal(row);
        }
      } catch (e) {
        sb = null;
      }
    }
    notify();
    return profile;
  }

  function signOut() {
    clearLocal();
    if (sb) {
      try {
        sb.auth.signOut();
      } catch (e) {}
    }
    notify();
  }

  function visitBasicsLine() {
    if (!profile) return "";
    var sexLabel = profile.sex === "female" ? "Female (FM)" : "Male (M)";
    return (
      "Visit basics — Age: " +
      profile.age +
      ". Sex: " +
      sexLabel +
      ". In Tennessee now: Yes."
    );
  }

  global.IspryAccount = {
    init: init,
    get: function () {
      return profile;
    },
    require: requireAccount,
    open: openModal,
    close: closeModal,
    signOut: signOut,
    onChange: function (fn) {
      onReady.push(fn);
    },
    visitBasicsLine: visitBasicsLine,
    getPendingPathway: getPendingPathway,
    setPendingPathway: setPendingPathway,
    esc: esc,
  };
})(window);
