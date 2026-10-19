// iSpry.ai — account gate (Supabase email+password; magic-link fallback + local profile).
// Profile fields: first_name, last_name, email, age, sex, in_tennessee (+ password for auth).
// Education chat is NOT stored here — only the account profile. Passwords never go in localStorage.
(function (global) {
  "use strict";

  var STORAGE_KEY = "ispry_account_v1";
  var PENDING_KEY = "ispry_pending_pathway";
  var PENDING_PROFILE_KEY = "ispry_pending_profile";
  var sb = null;
  var cfg = null;
  var profile = null;
  var onReady = [];
  var modalEl = null;
  var authListenerBound = false;

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

  function getPendingProfile() {
    try {
      var raw = sessionStorage.getItem(PENDING_PROFILE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function setPendingProfile(obj) {
    try {
      if (!obj) sessionStorage.removeItem(PENDING_PROFILE_KEY);
      else sessionStorage.setItem(PENDING_PROFILE_KEY, JSON.stringify(obj));
    } catch (e) {}
  }

  function redirectTo() {
    try {
      return global.location.origin + "/";
    } catch (e) {
      return "https://ispry.ai/";
    }
  }

  function hasAuthHash() {
    try {
      var h = String(global.location.hash || "");
      return h.indexOf("access_token=") !== -1 || h.indexOf("refresh_token=") !== -1;
    } catch (e) {
      return false;
    }
  }

  function clearAuthHash() {
    try {
      if (!hasAuthHash()) return;
      var url = global.location.pathname + global.location.search;
      global.history.replaceState(null, "", url || "/");
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
      '      <label class="f acct-create-only">First name<input name="first_name" autocomplete="given-name" maxlength="60"></label>' +
      '      <label class="f acct-create-only">Last name<input name="last_name" autocomplete="family-name" maxlength="60"></label>' +
      '      <label class="f acct-span2">Email<input name="email" type="email" autocomplete="email" required maxlength="120"></label>' +
      '      <label class="f acct-span2 acct-pw" id="acctPwWrap">Password<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="72" required placeholder="At least 8 characters"></label>' +
      '      <label class="f acct-span2 acct-pw acct-create-only" id="acctPwConfirmWrap">Confirm password<input name="password_confirm" type="password" autocomplete="new-password" minlength="8" maxlength="72" placeholder="Re-enter password"></label>' +
      '      <label class="f acct-create-only">Age (years)<input name="age" type="number" inputmode="numeric" min="18" max="120"></label>' +
      '      <label class="f acct-create-only">Sex<select name="sex"><option value="">Select</option><option value="male">Male (M)</option><option value="female">Female (FM)</option></select></label>' +
      '      <label class="f acct-span2 acct-create-only">Physically in Tennessee now?<select name="in_tennessee"><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select></label>' +
      '      <label class="f acct-span2 acct-otp" id="acctOtpWrap" hidden>Email code (optional)<input name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="Only if your email shows a code"></label>' +
      "    </div>" +
      '    <p class="acct-err" id="acctErr" role="alert" hidden></p>' +
      '    <p class="acct-note" id="acctNote"></p>' +
      '    <div class="acct-actions">' +
      '      <button class="btn" type="submit" id="acctSubmit">Continue</button>' +
      '      <button class="btn btn-ghost" type="button" id="acctModeToggle">I already have an account</button>' +
      '      <button class="btn btn-ghost" type="button" id="acctMagic" hidden>Email me a sign-in link</button>' +
      '      <button class="btn btn-ghost" type="button" id="acctResend" hidden>Resend email</button>' +
      "    </div>" +
      "  </form>" +
      "</div>";
    document.body.appendChild(modalEl);
    modalEl.addEventListener("click", function (e) {
      if (e.target && e.target.getAttribute("data-acct-close") === "1") closeModal();
    });
    document.getElementById("acctModeToggle").addEventListener("click", function () {
      state.mode = state.mode === "create" ? "signin" : "create";
      state.phase = "profile";
      state.authPath = "password";
      paintMode();
    });
    document.getElementById("acctMagic").addEventListener("click", function () {
      state.authPath = "magic";
      paintMode();
      onMagicLinkClick();
    });
    document.getElementById("acctResend").addEventListener("click", function () {
      onResend();
    });
    document.getElementById("acctForm").addEventListener("submit", onSubmit);
    return modalEl;
  }

  var state = {
    mode: "create", // create | signin
    phase: "profile", // profile | email_sent | confirm_email
    authPath: "password", // password | magic
    pendingResolve: null,
    pendingReject: null,
    otpEmail: "",
  };

  function setCreateOnlyVisible(show) {
    ensureModal();
    modalEl.querySelectorAll(".acct-create-only").forEach(function (el) {
      el.hidden = !show;
    });
  }

  function paintMode() {
    ensureModal();
    var title = document.getElementById("acctTitle");
    var lede = document.getElementById("acctLede");
    var toggle = document.getElementById("acctModeToggle");
    var note = document.getElementById("acctNote");
    var otpWrap = document.getElementById("acctOtpWrap");
    var resend = document.getElementById("acctResend");
    var magic = document.getElementById("acctMagic");
    var submit = document.getElementById("acctSubmit");
    var pwInput = document.querySelector('#acctForm input[name="password"]');
    var pwConfirm = document.querySelector('#acctForm input[name="password_confirm"]');
    var createMode = state.mode === "create";
    setCreateOnlyVisible(createMode && state.phase === "profile");
    if (pwInput) {
      pwInput.autocomplete = createMode ? "new-password" : "current-password";
      pwInput.required = state.phase === "profile" && state.authPath === "password";
      document.getElementById("acctPwWrap").hidden = state.phase !== "profile" || state.authPath === "magic";
    }
    if (pwConfirm) {
      pwConfirm.required = createMode && state.phase === "profile" && state.authPath === "password";
      document.getElementById("acctPwConfirmWrap").hidden =
        !(createMode && state.phase === "profile" && state.authPath === "password");
    }
    if (createMode) {
      title.textContent = "Start your iSpry account";
      lede.textContent =
        "Not membership yet — name, email, password, age, sex, and Tennessee so Spry can welcome you and keep going.";
      toggle.textContent = "I already have an account";
    } else {
      title.textContent = "Sign in to iSpry";
      lede.textContent = "Use the email and password on your account.";
      toggle.textContent = "Create an account instead";
    }
    if (state.phase === "email_sent" || state.phase === "confirm_email") {
      otpWrap.hidden = state.phase !== "email_sent";
      resend.hidden = false;
      toggle.hidden = true;
      magic.hidden = true;
      if (state.phase === "confirm_email") {
        note.textContent =
          "Check your email to confirm your account, then come back and sign in with your password.";
        submit.textContent = "I've confirmed — sign in";
      } else {
        note.textContent =
          "Check your email for a Sign in link. Open that link on this device. If a 6-digit code appears instead, enter it below.";
        submit.textContent = "I've opened the link";
      }
    } else {
      otpWrap.hidden = true;
      resend.hidden = true;
      toggle.hidden = false;
      magic.hidden = !(cfg && cfg.configured && state.mode === "signin");
      note.textContent = cfg && cfg.configured
        ? "Your password signs you in on return visits. Chat stays in this browser; your chart is in Akute after you become a member."
        : "Your account is saved in this browser for this visit. Membership payment still happens later through Stripe.";
      submit.textContent = createMode ? "Create account" : "Sign in";
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
    state.authPath = "password";
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
    paintMode();
    modalEl.hidden = false;
    document.body.classList.add("acct-open");
    try {
      if (state.mode === "signin") form.email.focus();
      else form.first_name.focus();
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
    var password = String(form.password.value || "");
    var password_confirm = String(form.password_confirm.value || "");
    return {
      first_name: first,
      last_name: last,
      email: email,
      age: age,
      sex: sex,
      loc: loc,
      otp: otp,
      password: password,
      password_confirm: password_confirm,
    };
  }

  function validatePassword(v, forCreate) {
    if (!v.password || v.password.length < 8) return "Choose a password with at least 8 characters.";
    if (v.password.length > 72) return "Password must be 72 characters or fewer.";
    if (forCreate && v.password !== v.password_confirm) return "Passwords do not match.";
    return null;
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
      in_tennessee: v.loc === "yes" || v.in_tennessee === true,
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

  async function sendMagicLink(email) {
    if (!sb) throw new Error("Auth is not ready.");
    var r = await sb.auth.signInWithOtp({
      email: email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: redirectTo(),
      },
    });
    if (r.error) throw new Error(r.error.message || "Could not send sign-in email.");
  }

  async function verifyOtp(email, token) {
    if (!sb) throw new Error("Auth is not ready.");
    var r = await sb.auth.verifyOtp({ email: email, token: token, type: "email" });
    if (r.error) throw new Error(r.error.message || "Invalid or expired code.");
    return r.data && r.data.user;
  }

  async function signUpWithPassword(v) {
    if (!sb) throw new Error("Auth is not ready.");
    var r = await sb.auth.signUp({
      email: v.email,
      password: v.password,
      options: {
        emailRedirectTo: redirectTo(),
        data: {
          first_name: v.first_name,
          last_name: v.last_name,
        },
      },
    });
    if (r.error) throw new Error(r.error.message || "Could not create account.");
    return r.data || {};
  }

  async function signInWithPassword(email, password) {
    if (!sb) throw new Error("Auth is not ready.");
    var r = await sb.auth.signInWithPassword({ email: email, password: password });
    if (r.error) throw new Error(r.error.message || "Email or password is incorrect.");
    return r.data && r.data.user;
  }

  async function onMagicLinkClick() {
    showErr("");
    var v = readForm();
    var e1 = validateProfile(v, true);
    if (e1) {
      showErr(e1);
      state.authPath = "password";
      paintMode();
      return;
    }
    if (!(sb && cfg && cfg.configured)) {
      showErr("Email link sign-in is not available right now. Use your password, or create an account.");
      state.authPath = "password";
      paintMode();
      return;
    }
    var btn = document.getElementById("acctMagic");
    if (btn) btn.disabled = true;
    try {
      stashPendingFromForm(v, "signin");
      await sendMagicLink(v.email);
      state.phase = "email_sent";
      state.otpEmail = v.email;
      paintMode();
    } catch (ex) {
      state.authPath = "password";
      showErr(ex.message || "Could not send sign-in email.");
      paintMode();
    } finally {
      if (btn) btn.disabled = false;
    }
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

  function stashPendingFromForm(v, mode) {
    setPendingProfile({
      mode: mode || state.mode,
      email: v.email,
      first_name: v.first_name,
      last_name: v.last_name,
      age: v.age,
      sex: v.sex,
      loc: v.loc,
      in_tennessee: v.loc === "yes",
      sent_at: Date.now(),
    });
  }

  async function completeWithUser(user) {
    if (!user) throw new Error("Sign-in did not finish. Open the link from your email again.");
    var pending = getPendingProfile();
    var existing = await fetchProfileRow(user.id);
    if (existing && (!pending || pending.mode === "signin")) {
      saveLocal(existing);
      setPendingProfile(null);
      return existing;
    }
    if (pending && pending.first_name && pending.last_name) {
      var v = {
        email: pending.email || (user.email || ""),
        first_name: pending.first_name,
        last_name: pending.last_name,
        age: pending.age,
        sex: pending.sex,
        loc: pending.loc || (pending.in_tennessee ? "yes" : "no"),
      };
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
      setPendingProfile(null);
      return profile;
    }
    if (existing) {
      saveLocal(existing);
      setPendingProfile(null);
      return existing;
    }
    throw new Error("Signed in, but your profile is incomplete. Create your account again.");
  }

  async function tryFinishFromSession() {
    if (!sb) return false;
    var sess = await sb.auth.getSession();
    var user = sess && sess.data && sess.data.session && sess.data.session.user;
    if (!user) return false;
    await completeWithUser(user);
    clearAuthHash();
    if (state.pendingResolve) resolveOk();
    else notify();
    return true;
  }

  async function onResend() {
    showErr("");
    var btn = document.getElementById("acctResend");
    if (btn) btn.disabled = true;
    try {
      var email = state.otpEmail || (readForm().email || "");
      if (!email) throw new Error("Enter your email first.");
      await sendMagicLink(email);
      showErr("");
      var note = document.getElementById("acctNote");
      if (note) note.textContent = "Another sign-in email is on the way. Open the newest Sign in link.";
    } catch (ex) {
      showErr(ex.message || "Could not resend email.");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    showErr("");
    var v = readForm();
    var btn = document.getElementById("acctSubmit");
    btn.disabled = true;
    try {
      if (state.phase === "confirm_email") {
        state.mode = "signin";
        state.phase = "profile";
        state.authPath = "password";
        paintMode();
        return;
      }

      if (state.phase === "email_sent") {
        // Optional numeric code path (only if the project's email template includes {{ .Token }}).
        if (v.otp) {
          if (!/^\d{6,8}$/.test(v.otp)) throw new Error("Enter the code from your email, or leave it blank and open the Sign in link.");
          var otpUser = await verifyOtp(state.otpEmail || v.email, v.otp);
          await completeWithUser(otpUser);
          resolveOk();
          return;
        }
        var finished = await tryFinishFromSession();
        if (finished) return;
        throw new Error(
          "Still waiting — open the Sign in link in your email (on this device). The link should return you to this site, not localhost.",
        );
      }

      if (state.mode === "signin") {
        var e1 = validateProfile(v, true);
        if (e1) throw new Error(e1);
        if (sb && cfg && cfg.configured) {
          var pwErr = validatePassword(v, false);
          if (pwErr) throw new Error(pwErr);
          stashPendingFromForm(v, "signin");
          var signedIn = await signInWithPassword(v.email, v.password);
          await completeWithUser(signedIn);
          resolveOk();
          return;
        }
        var cached = loadLocal();
        if (!cached || cached.email !== v.email) {
          throw new Error("No account on this device for that email. Create an account instead.");
        }
        // Local fallback cannot verify passwords; email match on this device is enough.
        saveLocal(cached);
        resolveOk();
        return;
      }

      // create
      var e2 = validateProfile(v, false);
      if (e2) throw new Error(e2);
      var pwCreateErr = validatePassword(v, true);
      if (pwCreateErr) throw new Error(pwCreateErr);
      if (sb && cfg && cfg.configured) {
        try {
          stashPendingFromForm(v, "create");
          var signed = await signUpWithPassword(v);
          var user = signed.user;
          if (signed.session && user) {
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
            setPendingProfile(null);
            resolveOk();
            return;
          }
          // Email confirmation required before a session exists.
          state.phase = "confirm_email";
          state.otpEmail = v.email;
          paintMode();
          return;
        } catch (authErr) {
          var msg = String((authErr && authErr.message) || "");
          // Surface real account errors; only fall back when auth itself is unreachable.
          if (/already|registered|exists|invalid|weak|password|credentials|rate|confirm/i.test(msg)) {
            throw authErr;
          }
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
    if (modalEl) {
      modalEl.hidden = true;
      document.body.classList.remove("acct-open");
    }
    var res = state.pendingResolve;
    state.pendingResolve = null;
    state.pendingReject = null;
    state.phase = "profile";
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

  function bindAuthListener() {
    if (!sb || authListenerBound) return;
    authListenerBound = true;
    try {
      sb.auth.onAuthStateChange(function (event, session) {
        if (event !== "SIGNED_IN" && event !== "INITIAL_SESSION") return;
        if (!session || !session.user) return;
        completeWithUser(session.user)
          .then(function () {
            clearAuthHash();
            if (state.pendingResolve) resolveOk();
            else notify();
          })
          .catch(function () { /* wait for form / retry */ });
      });
    } catch (e) {}
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
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
            flowType: "implicit",
          },
        });
        bindAuthListener();
        // Magic-link return: tokens land in the URL hash on this origin.
        var authed = false;
        if (hasAuthHash() || getPendingProfile()) {
          authed = await tryFinishFromSession();
        } else {
          var sess = await sb.auth.getSession();
          var user = sess && sess.data && sess.data.session && sess.data.session.user;
          if (user) {
            authed = true;
            var row = await fetchProfileRow(user.id);
            if (row) saveLocal(row);
            else authed = await tryFinishFromSession();
          }
        }
        // A leftover browser profile is not a signed-in patient. Without a session,
        // Sign out and a first name must not stay on screen.
        if (!authed) clearLocal();
      } catch (e) {
        sb = null;
      }
    }
    notify();
    return profile;
  }

  function signOut() {
    clearLocal();
    setPendingProfile(null);
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
