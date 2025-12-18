const form = document.getElementById("loginForm");
const errorBox = document.getElementById("error");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.textContent = "";

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      credentials: "include", // IMPORTANT (cookie)
      body: JSON.stringify({ email, password })
    });

   const raw = await res.text();
let data = {};
try { data = JSON.parse(raw); } catch {}

if (!res.ok) {
  throw new Error(data.error || data.message || raw || "Erreur de connexion");
}


    if (!res.ok) {
      throw new Error(data.error || "Erreur de connexion");
    }

    // Succès → redirection
    window.location.href = "/admin/";

  } catch (err) {
    errorBox.textContent = err.message;
  }
});
