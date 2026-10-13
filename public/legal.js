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
  fetch("/api/hint", { headers: { Accept: "application/json" } })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(data){
      if (!data || !data.signup_url) return;
      var u;
      try { u = new URL(data.signup_url); } catch (e) { return; }
      var host = u.hostname.toLowerCase();
      if (u.protocol !== "https:") return;
      if (host !== "hint.com" && host.slice(-9) !== ".hint.com") return;
      document.querySelectorAll(".js-join").forEach(function(a){ a.href = u.href; });
    })
    .catch(function(){});
})();
