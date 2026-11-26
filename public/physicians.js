(function(){
  var form = document.getElementById("applyForm");
  var btn = document.getElementById("applyBtn");
  var msg = document.getElementById("applyMsg");
  if (!form) return;
  function show(kind, html){ msg.className = "form-msg " + kind; msg.innerHTML = html; }
  var FALLBACK = 'Something went wrong sending that. Please call or text the practice at <a href="tel:+17314150724">(731) 415-0724</a>.';
  form.addEventListener("submit", function(e){
    e.preventDefault();
    var d = {};
    new FormData(form).forEach(function(v, k){ d[k] = String(v).trim(); });
    if (!d.name || !d.credential || !d.states || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email || "")) {
      show("err", "Please add your name, credential, a valid email, and the states you're licensed in.");
      return;
    }
    btn.disabled = true; btn.textContent = "Sending…";
    fetch("/api/clinician-interest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        if (res.ok && res.j && res.j.ok) {
          form.reset();
          show("ok", "Thanks, " + (d.name.split(" ")[0] || "doctor").replace(/[<>&]/g, "") + ". Your interest is in. We'll be in touch within a few business days.");
        } else {
          show("err", (res.j && res.j.error) ? String(res.j.error).replace(/[<>&]/g, "") : FALLBACK);
        }
      })
      .catch(function(){ show("err", FALLBACK); })
      .then(function(){ btn.disabled = false; btn.textContent = "Send my interest"; });
  });
})();
