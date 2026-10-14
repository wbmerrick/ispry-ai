(function(){
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
      if (c) document.querySelectorAll(".js-join").forEach(function(a){ a.href = c; });
      if (p) document.querySelectorAll(".js-portal").forEach(function(a){ a.href = p; });
    })
    .catch(function(){});
})();
