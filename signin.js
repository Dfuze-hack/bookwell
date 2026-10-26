(function () {
  "use strict";

  const accountClient = window.BookWellAccountClient;
  const core = window.BookWellAccountCore;
  const client = accountClient?.client || null;
  const elements = {
    status: document.getElementById("account-status"),
    auth: document.getElementById("account-auth"),
    signIn: document.getElementById("account-signin"),
    signUp: document.getElementById("account-signup"),
    forgot: document.getElementById("account-forgot"),
    reset: document.getElementById("account-reset"),
    email: document.getElementById("account-signin-email"),
    verify: document.getElementById("account-verification"),
    verificationResend: document.getElementById("account-verification-resend")
  };
  let recovering = false;

  function setStatus(message, isError) {
    elements.status.textContent = message;
    elements.status.classList.toggle("account-error", Boolean(isError));
    elements.status.setAttribute("role", isError ? "alert" : "status");
  }

  function setBusy(form, busy, label) {
    const submit = form.querySelector('[type="submit"]');
    if (!submit) return;
    if (busy) {
      submit.dataset.idleText = submit.textContent;
      submit.textContent = label || "Please wait…";
    } else if (submit.dataset.idleText) {
      submit.textContent = submit.dataset.idleText;
      delete submit.dataset.idleText;
    }
    submit.disabled = busy;
    form.setAttribute("aria-busy", String(busy));
  }

  function showAuthForm(form) {
    [elements.signIn, elements.signUp, elements.forgot, elements.reset]
      .forEach((item) => { item.hidden = item !== form; });
  }

  function homepageUrl() {
    return new URL("index.html#account", window.location.href).href;
  }

  function redirectUrl() {
    return new URL("signin.html", window.location.href).href;
  }

  function recoveryUrl() {
    return core.recoveryRedirectUrl(window.location.href);
  }

  function isRecoveryRequest() {
    return core.isRecoveryRequest(window.location.search);
  }

  function markRecoveryUrl() {
    if (isRecoveryRequest()) return;
    const url = new URL(window.location.href);
    url.searchParams.set("recovery", "1");
    window.history.replaceState(window.history.state, "", url.toString());
  }

  function clearRecoveryUrl() {
    const url = new URL(window.location.href);
    ["recovery", "code", "error", "error_code", "error_description"].forEach((key) => {
      url.searchParams.delete(key);
    });
    window.history.replaceState(window.history.state, "", url.toString());
  }

  function showRecoveryForm() {
    if (recovering) return;
    recovering = true;
    markRecoveryUrl();
    elements.verify.hidden = true;
    showAuthForm(elements.reset);
    const input = elements.reset.querySelector("input");
    if (input) input.focus();
    setStatus("Choose a new password for your account.", false);
  }

  function showRecoveryError() {
    recovering = false;
    clearRecoveryUrl();
    elements.verify.hidden = true;
    showAuthForm(elements.signIn);
    setStatus("This password-reset link is invalid or has expired. Request a new link and try again.", true);
  }

  function friendlyError(error) {
    const message = String(error?.message || "");
    if (/email not confirmed|verify.*email|email.*verif/i.test(message)) {
      elements.verify.hidden = false;
      return "Please verify your email address before signing in. You can request a new verification email below.";
    }
    if (/invalid login credentials/i.test(message)) return "The email or password was not recognized.";
    if (/invalid or has expired|auth session missing|invalid.*(?:token|session)|token.*expired|code verifier/i.test(message)) {
      return "This password-reset link is invalid or has expired. Request a new link and try again.";
    }
    if (/rate limit|too many requests/i.test(message)) return "Too many attempts. Please wait a little before trying again.";
    if (/password should be at least|password.*characters/i.test(message)) return "Choose a longer password that meets the project's password requirements.";
    return message || "This account request could not be completed. Please try again.";
  }

  function requireClient() {
    if (client) return true;
    setStatus("Account sign-in is unavailable. Configure Supabase and make sure its JavaScript client can load.", true);
    return false;
  }

  async function handleSignIn(event) {
    event.preventDefault();
    if (!requireClient()) return;
    const data = new FormData(elements.signIn);
    const email = String(data.get("email")).trim();
    setBusy(elements.signIn, true, "Signing in…");
    setStatus("Signing in securely…", false);
    try {
      const { data: result, error } = await client.auth.signInWithPassword({
        email,
        password: String(data.get("password"))
      });
      if (error) throw error;
      if (!core.isEmailVerified(result.user)) {
        elements.email.value = email;
        await client.auth.signOut();
        elements.verify.hidden = false;
        throw new Error("Email verification is required before you can use your account.");
      }
      elements.signIn.reset();
      window.location.replace(homepageUrl());
    } catch (error) {
      setStatus(friendlyError(error), true);
    } finally {
      setBusy(elements.signIn, false);
    }
  }

  async function handleSignUp(event) {
    event.preventDefault();
    if (!requireClient()) return;
    const data = new FormData(elements.signUp);
    const email = String(data.get("email")).trim();
    if (data.get("password") !== data.get("confirm_password")) {
      setStatus("The passwords do not match.", true);
      return;
    }
    setBusy(elements.signUp, true, "Creating your account…");
    setStatus("Creating your account…", false);
    try {
      const { data: result, error } = await client.auth.signUp({
        email,
        password: String(data.get("password")),
        options: { emailRedirectTo: redirectUrl() }
      });
      if (error) throw error;
      elements.email.value = email;
      elements.signUp.reset();
      showAuthForm(elements.signIn);
      if (!result.session || !core.isEmailVerified(result.user)) {
        if (result.session) await client.auth.signOut();
        elements.verify.hidden = false;
        setStatus("Check your inbox to verify your email before signing in.", false);
      } else {
        window.location.replace(homepageUrl());
      }
    } catch (error) {
      setStatus(friendlyError(error), true);
    } finally {
      setBusy(elements.signUp, false);
    }
  }

  async function handleForgotPassword(event) {
    event.preventDefault();
    if (!requireClient()) return;
    const email = String(new FormData(elements.forgot).get("email")).trim();
    setBusy(elements.forgot, true, "Sending instructions…");
    setStatus("Sending password-reset instructions…", false);
    try {
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: recoveryUrl() });
      if (error) throw error;
      setStatus("If an account exists for that address, password-reset instructions have been sent.", false);
    } catch (error) {
      setStatus(friendlyError(error), true);
    } finally {
      setBusy(elements.forgot, false);
    }
  }

  async function handlePasswordReset(event) {
    event.preventDefault();
    if (!requireClient()) return;
    const data = new FormData(elements.reset);
    if (data.get("password") !== data.get("confirm_password")) {
      setStatus("The passwords do not match.", true);
      return;
    }
    let updated = false;
    setBusy(elements.reset, true, "Updating password…");
    try {
      const { error } = await client.auth.updateUser({ password: String(data.get("password")) });
      if (error) throw error;
      updated = true;
      recovering = false;
      elements.reset.reset();
      clearRecoveryUrl();
      setBusy(elements.reset, true, "Password updated");
      setStatus("Your password was updated. Returning to BookWell…", false);
      window.setTimeout(() => window.location.replace(homepageUrl()), 1200);
    } catch (error) {
      setStatus(friendlyError(error), true);
    } finally {
      if (!updated) setBusy(elements.reset, false);
    }
  }

  async function resendVerification() {
    if (!requireClient()) return;
    const email = elements.email.value.trim();
    if (!email) {
      setStatus("Enter your email address before requesting another verification email.", true);
      return;
    }
    elements.verificationResend.disabled = true;
    setStatus("Requesting another verification email…", false);
    try {
      const { error } = await client.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: redirectUrl() }
      });
      if (error) throw error;
      setStatus("If that address has an unverified account, a new verification email has been sent.", false);
    } catch (error) {
      setStatus(friendlyError(error), true);
    } finally {
      elements.verificationResend.disabled = false;
    }
  }

  elements.signIn.addEventListener("submit", handleSignIn);
  elements.signUp.addEventListener("submit", handleSignUp);
  elements.forgot.addEventListener("submit", handleForgotPassword);
  elements.reset.addEventListener("submit", handlePasswordReset);
  elements.verificationResend.addEventListener("click", resendVerification);
  document.getElementById("account-show-signup")
    .addEventListener("click", () => showAuthForm(elements.signUp));
  document.getElementById("account-show-forgot")
    .addEventListener("click", () => showAuthForm(elements.forgot));
  document.querySelectorAll("[data-account-show-signin]").forEach((button) => {
    button.addEventListener("click", () => showAuthForm(elements.signIn));
  });
  document.querySelectorAll("[data-password-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.passwordToggle);
      if (!input) return;
      const visible = input.type === "password";
      input.type = visible ? "text" : "password";
      button.setAttribute("aria-pressed", String(visible));
      button.setAttribute("aria-label", visible ? "Hide password" : "Show password");
    });
  });

  const availability = core.availability(accountClient?.configured(), Boolean(client));
  if (availability === "not-configured") {
    setStatus("Sign-in needs a configured Supabase project. Browse the public library while account access is being set up.", false);
  } else if (availability === "client-unavailable") {
    setStatus("Account sign-in is unavailable because the Supabase JavaScript client did not load.", true);
  } else {
    setStatus("Your BookWell account keeps saved resources and your personal library together.", false);
    client.auth.onAuthStateChange((event, session) => {
      const recovery = core.recoveryState(event, session, isRecoveryRequest());
      if (recovery === "reset") {
        showRecoveryForm();
        return;
      }
      if (recovery === "invalid") {
        showRecoveryError();
        return;
      }
      if (recovery === "pending") return;
      if (event === "SIGNED_OUT" && recovering) {
        showRecoveryError();
        return;
      }
      if (event === "INITIAL_SESSION" && session?.user) {
        if (recovering) return;
        if (core.isEmailVerified(session.user)) {
          window.location.replace(homepageUrl());
        } else {
          elements.email.value = session.user.email || "";
          elements.verify.hidden = false;
          setStatus("Please verify your email address before accessing your account.", true);
          window.setTimeout(() => client.auth.signOut().catch(() => {
            setStatus("Your email is not verified. Please close this page if the session could not be cleared.", true);
          }), 0);
        }
      }
    });
  }
})();
