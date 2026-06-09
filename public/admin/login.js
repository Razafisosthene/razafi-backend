const form = document.getElementById("loginForm");
const errorBox = document.getElementById("error");
const googleSignInButton = document.getElementById("googleSignInButton");

function showError(message) {
  errorBox.textContent = message || "";
}

async function readJSONResponse(res) {
  const raw = await res.text();
  let data = {};
  try { data = JSON.parse(raw); } catch {}
  if (!res.ok) {
    throw new Error(data.error || data.message || raw || "Erreur de connexion");
  }
  return data;
}

async function redirectAfterLogin() {
  window.location.href = "/admin/";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");

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

    await readJSONResponse(res);
    await redirectAfterLogin();
  } catch (err) {
    showError(err.message);
  }
});

async function handleGoogleCredential(response) {
  showError("");

  try {
    const credential = response && response.credential ? response.credential : "";
    if (!credential) throw new Error("Connexion Google annulée");

    const res = await fetch("/api/admin/google-login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      credentials: "include", // IMPORTANT (cookie)
      body: JSON.stringify({ credential })
    });

    await readJSONResponse(res);
    await redirectAfterLogin();
  } catch (err) {
    showError(err.message || "Connexion Google impossible");
  }
}

async function initGoogleSignIn() {
  try {
    if (!googleSignInButton) return;

    const configRes = await fetch("/api/admin/google-config", {
      method: "GET",
      credentials: "include"
    });
    const config = await readJSONResponse(configRes);

    if (!config.enabled || !config.client_id) {
      googleSignInButton.style.display = "none";
      return;
    }

    const waitForGoogle = () => new Promise((resolve, reject) => {
      let tries = 0;
      const timer = setInterval(() => {
        tries += 1;
        if (window.google && window.google.accounts && window.google.accounts.id) {
          clearInterval(timer);
          resolve();
        } else if (tries > 50) {
          clearInterval(timer);
          reject(new Error("Google Sign-In indisponible"));
        }
      }, 100);
    });

    await waitForGoogle();

    window.google.accounts.id.initialize({
      client_id: config.client_id,
      callback: handleGoogleCredential
    });

    window.google.accounts.id.renderButton(googleSignInButton, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "continue_with",
      shape: "pill",
      width: 260
    });
  } catch (err) {
    // Google login is optional. Never break password login if Google fails.
    console.warn("Google Sign-In init failed", err);
    if (googleSignInButton) googleSignInButton.style.display = "none";
  }
}

initGoogleSignIn();
