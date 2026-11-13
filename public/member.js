// iSpry.ai — signed-in member home. Reads the Supabase session created on the homepage,
// then asks /api/member for membership status (Stripe) and visits this month (Akute).
// Nothing clinical is kept in this browser: the request text is sent once and cleared.
(function (global) {
  "use strict";

  var STORAGE_KEY = "ispry_account_v1"; // account.js profile (first name only is used here)
  var sb = null;
  var token = "";

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.hidden = !on; }
  function text(id, s) { var el = $(id); if (el) el.textContent = s; }

  function httpsUrl(url, hosts) {
    try {
      var u = new URL(String(url || ""));
      if (u.protocol !== "https:") return "";
      if (hosts && hosts.indexOf(u.hostname.toLowerCase()) === -1) return "";
      return u.href;
    } catch (e) { return ""; }
  }
  var STRIPE_HOSTS = ["buy.stripe.com", "checkout.stripe.com", "billing.stripe.com"];

  function prettyDate(iso) {
    if (!iso) return "";
    var d = new Date(iso + "T12:00:00Z");
    if (isNaN(d)) return "";
    return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  }

  function firstName() {
    try {
      var p = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      return p && p.first_name ? String(p.first_name).slice(0, 60) : "";
    } catch (e) { return ""; }
  }

  function action(label, href, ghost) {
    var a = document.createElement("a");
    a.className = "btn" + (ghost ? " btn-ghost" : "");
    a.textContent = label;
    a.href = href;
    a.rel = "noopener";
    return a;
  }

  function signedOut() {
    token = "";
    text("mTitle", "Your iSpry home.");
    text("mLede", "Membership, visits, and requests to your physician in one place.");
    show($("mSignedIn"), false);
    show($("mSignedOut"), true);
  }

  function paintMembership(m, links) {
    var status = $("mMemStatus");
    var actions = $("mMemActions");
    actions.textContent = "";
    status.classList.remove("warn");
    var portal = httpsUrl(links.portal_url, STRIPE_HOSTS);
    var join = httpsUrl(links.join_url, STRIPE_HOSTS);
    var when = prettyDate(m.date);
    if (m.status === "active") {
      status.textContent = "Active";
      text("mMemSub", "$100 a month" + (when ? ". Renews " + when + "." : "."));
      if (portal) actions.appendChild(action("Manage billing", portal, true));
    } else if (m.status === "canceling") {
      status.textContent = "Ending";
      text("mMemSub", when ? "Your membership stays active through " + when + "." : "Your membership is set to end at the close of this billing period.");
      if (portal) actions.appendChild(action("Keep my membership", portal, true));
    } else if (m.status === "past_due") {
      status.textContent = "Payment failed";
      status.classList.add("warn");
      text("mMemSub", "Your last payment did not go through. Update your card to keep your membership.");
      if (portal) actions.appendChild(action("Update card", portal, false));
    } else if (m.status === "none") {
      status.textContent = "Not a member";
      text("mMemSub", "No membership under this email. Visits are $49 each, or $100 a month covers up to 3 visits.");
      if (join) actions.appendChild(action("Join for $100/month", join, false));
    } else {
      status.textContent = "Unavailable";
      text("mMemSub", "We couldn't check your membership just now. Your billing page has the current status.");
      if (portal) actions.appendChild(action("Open billing", portal, true));
    }
  }

  function paintVisits(v, m) {
    var member = m.status === "active" || m.status === "canceling";
    if (v.used === null || v.used === undefined) {
      text("mVisStatus", member ? "Up to " + v.cap : "$49 each");
      text("mVisSub", member
        ? "Membership covers up to " + v.cap + " visits a month, up to 3 problems per visit."
        : "One problem per visit. It does not renew.");
      return;
    }
    if (member) {
      text("mVisStatus", v.left + " of " + v.cap + " left");
      text("mVisSub", v.used + " booked so far this month. Up to 3 problems per visit." +
        (v.left === 0 ? " Call the practice line if you need another visit before next month." : ""));
    } else {
      text("mVisStatus", v.used + " booked");
      text("mVisSub", "Visits are $49 each without a membership.");
    }
  }

  function paintLinks(links) {
    var forms = httpsUrl(links.forms_url);
    var book = httpsUrl(links.booking_url);
    var chart = httpsUrl(links.chart_url);
    if (forms) { $("mFormsLink").href = forms; show($("mStepForms"), true); }
    if (book) { $("mBookLink").href = book; show($("mStepBook"), true); }
    if (chart) $("mChartLink").href = chart;
    var portal = httpsUrl(links.portal_url, STRIPE_HOSTS);
    if (portal) $("mPortalLink").href = portal;
  }

  async function load(session) {
    token = session.access_token;
    var name = firstName();
    text("mTitle", name ? "Hi, " + name + "." : "Welcome back.");
    text("mLede", "Loading your membership and visits…");
    text("mEmail", "Signed in as " + (session.user && session.user.email ? session.user.email : "your account"));
    show($("mSignedOut"), false);
    show($("mSignedIn"), true);
    var r, data;
    try {
      r = await fetch("/api/member", { headers: { Accept: "application/json", Authorization: "Bearer " + token } });
      data = await r.json();
    } catch (e) { r = null; }
    if (r && r.status === 401) return signedOut();
    if (!r || !r.ok || !data) {
      text("mLede", "We couldn't load your membership and visits just now. Everything below still works.");
      text("mMemStatus", "Unavailable");
      text("mVisStatus", "Unavailable");
      show($("mReqForm"), true);
      return;
    }
    text("mLede", "Membership, visits, and requests to your physician in one place.");
    paintMembership(data.membership, data.links);
    paintVisits(data.visits, data.membership);
    paintLinks(data.links);
    // Only a definite "no chart" hides the form; an unknown (lookup failed) keeps it.
    show($("mReqForm"), data.chart_linked !== false);
    show($("mNoChart"), data.chart_linked === false);
  }

  function reqMsg(s, cls) {
    var el = $("mReqMsg");
    el.textContent = s;
    el.className = "m-msg" + (cls ? " " + cls : "");
  }

  async function onRequest(e) {
    e.preventDefault();
    var kind = $("mKind").value;
    var message = $("mMessage").value.trim();
    if (!kind) { reqMsg("Choose what this request is about.", "err"); $("mKind").focus(); return; }
    if (message.length < 10) { reqMsg("Add a sentence or two so your physician knows what you need.", "err"); $("mMessage").focus(); return; }
    if (!$("mTN").checked) { reqMsg("Confirm you are in Tennessee right now.", "err"); $("mTN").focus(); return; }
    var btn = $("mReqSend");
    btn.disabled = true;
    reqMsg("Sending…");
    try {
      // Refresh the session so a long-open tab does not send an expired token.
      var s = await sb.auth.getSession();
      var fresh = s && s.data && s.data.session;
      if (!fresh) { signedOut(); return; }
      var r = await fetch("/api/member", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + fresh.access_token },
        body: JSON.stringify({ kind: kind, message: message, in_tennessee: true, website: $("mWebsite").value }),
      });
      var data = await r.json().catch(function () { return null; });
      if (r.status === 401) { signedOut(); return; }
      if (r.ok) {
        $("mReqForm").reset();
        reqMsg("Sent. Your physician will see it with your chart and follow up from the practice.", "ok");
      } else if (data && data.error === "no_chart") {
        show($("mReqForm"), false);
        show($("mNoChart"), true);
      } else if (data && data.error === "not_configured") {
        reqMsg("Requests are not available right now. Please call (731) 415-0724.", "err");
      } else {
        reqMsg((data && data.error) || "That didn't send. Please try again, or call (731) 415-0724.", "err");
      }
    } catch (ex) {
      reqMsg("That didn't send. Check your connection and try again.", "err");
    } finally {
      btn.disabled = false;
    }
  }

  async function init() {
    $("mReqForm").addEventListener("submit", onRequest);
    $("mSignOut").addEventListener("click", function () {
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
      var done = function () { global.location.href = "/"; };
      if (sb) sb.auth.signOut().then(done, done); else done();
    });
    var cfg = null;
    try {
      var r = await fetch("/api/auth-config", { headers: { Accept: "application/json" } });
      cfg = r.ok ? await r.json() : null;
    } catch (e) { cfg = null; }
    var createClient = global.supabase && (global.supabase.createClient || (global.supabase.default && global.supabase.default.createClient));
    if (!cfg || !cfg.configured || typeof createClient !== "function") return signedOut();
    try {
      sb = createClient(cfg.supabase_url, cfg.anon_key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: "implicit" },
      });
      var s = await sb.auth.getSession();
      var session = s && s.data && s.data.session;
      if (!session || !session.user) return signedOut();
      await load(session);
    } catch (e) {
      signedOut();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})(window);
