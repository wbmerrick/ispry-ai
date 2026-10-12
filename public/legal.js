(function(){
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
