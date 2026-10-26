(function () {
  "use strict";

  const accountClient = window.BookWellAccountClient;
  const core = window.BookWellAccountCore;
  const client = accountClient?.client || null;
  const inlineAuthEnabled = document.body.hasAttribute("data-inline-auth");
  const elements = {
    accountNav: document.getElementById("account-nav"),
    status: document.getElementById("account-status"),
    auth: document.getElementById("account-auth"),
    dashboard: document.getElementById("account-dashboard"),
    signIn: document.getElementById("account-signin"),
    signUp: document.getElementById("account-signup"),
    forgot: document.getElementById("account-forgot"),
    reset: document.getElementById("account-reset"),
    verify: document.getElementById("account-verification"),
    email: document.getElementById("account-signin-email"),
    welcome: document.getElementById("account-welcome"),
    displayName: document.getElementById("account-display-name"),
    emailLabel: document.getElementById("account-email-label"),
    savedCount: document.getElementById("account-saved-count"),
    libraryCount: document.getElementById("account-library-count"),
    saved: document.getElementById("account-saved-products"),
    recent: document.getElementById("account-recent"),
    purchases: document.getElementById("account-purchases"),
    purchaseStatus: document.getElementById("account-purchase-status"),
    purchaseProducts: document.getElementById("account-purchased-products"),
    purchasesStatus: document.getElementById("account-purchases-status"),
    purchasesMore: document.getElementById("account-purchases-more"),
    purchasesRetry: document.getElementById("account-purchases-retry"),
    purchasesCount: document.getElementById("account-purchases-count"),
    freeProducts: document.getElementById("account-free-products"),
    freeStatus: document.getElementById("account-free-status"),
    freeMore: document.getElementById("account-free-more"),
    freeRetry: document.getElementById("account-free-retry"),
    freeCount: document.getElementById("account-free-count"),
    otherPanel: document.getElementById("account-other-panel"),
    otherProducts: document.getElementById("account-other-products"),
    otherStatus: document.getElementById("account-other-status"),
    otherMore: document.getElementById("account-other-more"),
    otherRetry: document.getElementById("account-other-retry"),
    otherCount: document.getElementById("account-other-count"),
    profile: document.getElementById("account-profile"),
    signOut: document.getElementById("account-signout")
  };
  let currentUser = null;
  let savedProductIds = new Set();
  let busyProductIds = new Set();
  let dashboardRequest = 0;
  let authEvent = "INITIAL_SESSION";
  let profileExists = false;
  let purchasePolls = 0;
  let purchasePollTimer = null;
  let purchaseHistoryRows = [];
  let ownedProductIds = new Set();
  let checkedProductIds = new Set();
  let checkedOwnedProductIds = new Set();
  let accessStatus = client ? "loading" : "signed_out";
  let accessComplete = false;

  const LIBRARY_PAGE_SIZE = 24;
  const librarySections = {
    purchases: {
      label: "purchases",
      loadingLabel: "Loading purchases…",
      emptyLabel: "No provider-verified purchases with current access yet.",
      grid: elements.purchaseProducts,
      status: elements.purchasesStatus,
      more: elements.purchasesMore,
      retry: elements.purchasesRetry,
      count: elements.purchasesCount,
      panel: null,
      rows: [],
      cursor: null,
      hasMore: true,
      loading: false,
      loaded: false,
      error: null,
      requestId: 0
    },
    free: {
      label: "free downloads",
      loadingLabel: "Loading free downloads…",
      emptyLabel: "No published free downloads are available right now.",
      grid: elements.freeProducts,
      status: elements.freeStatus,
      more: elements.freeMore,
      retry: elements.freeRetry,
      count: elements.freeCount,
      panel: null,
      rows: [],
      cursor: null,
      hasMore: true,
      loading: false,
      loaded: false,
      error: null,
      requestId: 0
    },
    additional: {
      label: "additional access",
      loadingLabel: "Loading additional access…",
      emptyLabel: "No other authorized resources are available.",
      grid: elements.otherProducts,
      status: elements.otherStatus,
      more: elements.otherMore,
      retry: elements.otherRetry,
      count: elements.otherCount,
      panel: elements.otherPanel,
      rows: [],
      cursor: null,
      hasMore: true,
      loading: false,
      loaded: false,
      error: null,
      requestId: 0
    }
  };

  function setStatus(message, isError) {
    elements.status.textContent = message;
    elements.status.hidden = !message;
    elements.status.setAttribute("role", isError ? "alert" : "status");
    elements.status.classList.toggle("account-error", Boolean(isError));
  }

  function updateAccountNavigation(session) {
    if (!elements.accountNav) return;
    const navigation = core.accountNavigation(session);
    elements.accountNav.textContent = navigation.label;
    elements.accountNav.href = navigation.href;
  }

  function setBusy(form, busy, submitText) {
    const submit = form.querySelector('[type="submit"]');
    if (submit) {
      if (busy) {
        submit.dataset.idleText = submit.textContent;
        submit.textContent = submitText || "Please wait…";
      } else if (submit.dataset.idleText) {
        submit.textContent = submit.dataset.idleText;
        delete submit.dataset.idleText;
      }
      submit.disabled = busy;
    }
    form.setAttribute("aria-busy", String(busy));
  }

  function showAuthForm(form) {
    [elements.signIn, elements.signUp, elements.forgot, elements.reset]
      .forEach((item) => { item.hidden = item !== form; });
  }

  function redirectUrl() {
    return new URL("signin.html", window.location.href).href;
  }

  function isEmailVerified(user) {
    return core.isEmailVerified(user);
  }

  function accessSnapshot() {
    const signedIn = core.isSignedIn({ user: currentUser }) && isEmailVerified(currentUser);
    return {
      signedIn: signedIn,
      status: signedIn ? accessStatus : "signed_out",
      complete: signedIn ? accessComplete : true,
      isChecked: function (productId) {
        return signedIn && accessStatus === "ready" &&
          core.isProductId(productId) && checkedProductIds.has(productId);
      },
      isOwned: function (productId) {
        return signedIn && accessStatus === "ready" &&
          core.isProductId(productId) && ownedProductIds.has(productId);
      }
    };
  }

  function notifyAccessChange() {
    window.dispatchEvent(new CustomEvent("bookwell:accesschange"));
  }

  function beginAccessLoad() {
    accessStatus = client ? "loading" : "signed_out";
    accessComplete = false;
    ownedProductIds = new Set();
    checkedProductIds = new Set();
    checkedOwnedProductIds = new Set();
    notifyAccessChange();
  }

  function clearAccess() {
    accessStatus = "signed_out";
    accessComplete = true;
    ownedProductIds = new Set();
    checkedProductIds = new Set();
    checkedOwnedProductIds = new Set();
    purchaseHistoryRows = [];
    resetLibrarySections();
    notifyAccessChange();
  }

  function updateLibraryAccess() {
    const purchases = librarySections.purchases;
    const additional = librarySections.additional;
    const required = [purchases, additional];
    const settled = required.every((state) => state.loaded || Boolean(state.error));
    const failed = required.some((state) => !state.loaded && Boolean(state.error));
    const owned = new Set(checkedOwnedProductIds);
    [purchases, additional].forEach((state) => {
      state.rows.forEach((product) => {
        if (core.isProductId(product?.id)) owned.add(product.id);
      });
    });
    ownedProductIds = owned;
    if (!settled) {
      accessStatus = "loading";
      accessComplete = false;
    } else if (failed) {
      accessStatus = "error";
      accessComplete = false;
    } else {
      accessStatus = "ready";
      accessComplete = !purchases.hasMore && !additional.hasMore;
    }
    notifyAccessChange();
  }

  async function checkProductAccess(productId) {
    if (!client || !accessSnapshot().signedIn || !core.isProductId(productId)) return false;
    const { data, error } = await client.rpc("can_download_product", { target_product: productId });
    if (error) throw error;
    checkedProductIds.add(productId);
    if (data === true) {
      checkedOwnedProductIds.add(productId);
      ownedProductIds.add(productId);
      accessStatus = "ready";
    }
    notifyAccessChange();
    return data === true;
  }

  async function refreshAccess() {
    if (!client || !currentUser) return false;
    await loadDashboard(currentUser);
    return accessStatus === "ready";
  }

  function friendlyAuthError(error) {
    const message = String(error?.message || "");
    if (/email not confirmed|verify.*email|email.*verif/i.test(message)) {
      elements.verify.hidden = false;
      return "Please verify your email address before signing in. You can request a new verification email below.";
    }
    if (/invalid login credentials/i.test(message)) return "The email or password was not recognized.";
    if (/rate limit|too many requests/i.test(message)) return "Too many attempts. Please wait a little before trying again.";
    if (/password should be at least|password.*characters/i.test(message)) return "Choose a longer password that meets the project's password requirements.";
    return message || "This account request could not be completed. Please try again.";
  }

  function addText(parent, tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text || "";
    if (className) node.className = className;
    parent.appendChild(node);
    return node;
  }

  function productCard(product, saved, createdAt) {
    const card = document.createElement("article");
    card.className = "account-resource-card";
    if (product.preview_path && window.BookWellMarketplace?.showPreview) {
      const image = document.createElement("img");
      image.className = "product-preview";
      image.loading = "lazy";
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      card.appendChild(image);
      window.BookWellMarketplace.showPreview(image, product.preview_path);
    } else {
      addText(card, "div", product.formats?.[0] || "Learning resource", "product-cover-fallback");
    }
    addText(card, "h4", product.title);
    addText(card, "p", product.description || "A resource in the BookWell library.");
    if (createdAt) {
      addText(card, "p", "Download link authorized " + new Date(createdAt).toLocaleDateString(), "account-muted");
    }
    if (!saved && product.status && !["published"].includes(product.status)) {
      addText(card, "p", "Archived listing — your existing access remains available.", "account-muted");
    }
    const actions = document.createElement("div");
    actions.className = "product-actions";
    if (saved || !product.status || product.status === "published") {
      const details = document.createElement("a");
      details.className = "button secondary";
      details.href = "#product/" + encodeURIComponent(product.slug);
      details.textContent = "Resource details";
      actions.appendChild(details);
    }
    if (saved) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button secondary";
      remove.textContent = "Remove saved";
      remove.addEventListener("click", () => toggleSavedProduct(product));
      actions.appendChild(remove);
    } else {
      const download = document.createElement("button");
      download.type = "button";
      download.className = "button";
      download.textContent = "Download";
      download.addEventListener("click", () => {
        if (!window.BookWellMarketplace?.downloadProduct) {
          setStatus("Secure downloads are unavailable until the marketplace script loads.", true);
          return;
        }
        window.BookWellMarketplace.downloadProduct(product, {
          onStatus: function (message, isError) { setStatus(message, isError); }
        });
      });
      actions.appendChild(download);
    }
    card.appendChild(actions);
    return card;
  }

  function renderProducts(container, rows, saved) {
    container.replaceChildren();
    if (!rows.length) {
      addText(container, "p", saved
        ? "Save resources from the Library and they will be collected here."
        : "Resources you are authorized to access will appear here. Free resources are available to every learner; paid access requires a verified entitlement.", "account-empty");
      return;
    }
    rows.forEach((row) => {
      const product = row.product || row;
      container.appendChild(productCard(product, saved, saved ? null : row.created_at));
    });
  }

  function updateLibraryCount() {
    const sections = [librarySections.purchases, librarySections.free, librarySections.additional];
    const loaded = sections.reduce((total, state) => total + state.rows.length, 0);
    const hasMore = sections.some((state) => state.loaded && state.hasMore && !state.error);
    elements.libraryCount.textContent = String(loaded) + (hasMore ? "+" : "");
    sections.forEach((state) => {
      const sectionHasMore = state.loaded && state.hasMore && !state.error;
      state.count.textContent = String(state.rows.length) + (sectionHasMore ? "+" : "");
    });
  }

  function renderLibrarySection(section) {
    const state = librarySections[section];
    const loadedMessage = state.loaded ? "More " + state.label : "Your " + state.label;
    state.grid.setAttribute("aria-busy", String(state.loading));
    state.grid.replaceChildren();
    if (!state.rows.length && state.loaded && !state.error) {
      addText(state.grid, "p", state.emptyLabel, "account-empty");
    } else {
      state.rows.forEach((product) => {
        state.grid.appendChild(productCard(product, false));
      });
    }

    let statusMessage = "";
    let statusIsError = false;
    if (state.loading) {
      statusMessage = state.rows.length ? "Loading more " + state.label + "…" : state.loadingLabel;
    } else if (state.error) {
      statusMessage = loadedMessage + " could not be loaded. Check your connection and retry.";
      statusIsError = true;
    }
    state.status.textContent = statusMessage;
    state.status.hidden = !statusMessage;
    state.status.setAttribute("role", statusIsError ? "alert" : "status");
    state.status.classList.toggle("account-error", statusIsError);

    state.more.hidden = !(state.loaded && state.hasMore && !state.loading && !state.error);
    state.retry.hidden = !(state.error && !state.loading);
    state.more.disabled = state.loading;
    state.retry.disabled = state.loading;
    if (state.panel) {
      state.panel.hidden = state.loaded && !state.rows.length && !state.error && !state.loading;
    }
    updateLibraryCount();
  }

  function resetLibrarySections() {
    Object.keys(librarySections).forEach((section) => {
      const state = librarySections[section];
      state.requestId += 1;
      state.rows = [];
      state.cursor = null;
      state.hasMore = true;
      state.loading = false;
      state.loaded = false;
      state.error = null;
      renderLibrarySection(section);
    });
    updateLibraryCount();
    renderPurchaseHistory(purchaseHistoryRows);
  }

  async function loadLibrarySection(section, options) {
    const state = librarySections[section];
    if (!client || !currentUser || state.loading) return;
    const append = Boolean(options?.append) && state.loaded;
    if (append && !state.hasMore) return;
    const user = currentUser;
    const requestId = ++state.requestId;
    const cursor = append ? state.cursor : null;
    if (!append) {
      state.rows = [];
      state.cursor = null;
      state.hasMore = true;
      state.loaded = false;
    }
    state.loading = true;
    state.error = null;
    renderLibrarySection(section);
    if (section === "purchases") renderPurchaseHistory(purchaseHistoryRows);

    try {
      const request = core.libraryPageRequest(section, cursor, LIBRARY_PAGE_SIZE);
      const { data, error } = await client.rpc(request.rpc, request.args);
      if (currentUser?.id !== user.id || state.requestId !== requestId) return;
      if (error) throw error;
      const page = core.libraryPage(data, LIBRARY_PAGE_SIZE, section);
      state.rows = append ? core.mergeLibraryRows(state.rows, page.rows) : page.rows;
      state.cursor = page.cursor;
      state.hasMore = page.hasMore;
      state.loaded = true;
      state.error = null;
    } catch (error) {
      if (currentUser?.id !== user.id || state.requestId !== requestId) return;
      state.error = error;
    }

    state.loading = false;
    renderLibrarySection(section);
    if (section === "purchases") renderPurchaseHistory(purchaseHistoryRows);
    if (section === "purchases" || section === "additional") updateLibraryAccess();
  }

  function renderPurchaseHistory(rows) {
    const purchaseProducts = librarySections.purchases.rows;
    const purchasesState = librarySections.purchases;
    elements.purchases.replaceChildren();
    if (!rows.length) {
      addText(elements.purchases, "p", "Your verified BookWell purchases will appear here.", "purchase-empty");
      return;
    }
    rows.forEach((purchase) => {
      const row = document.createElement("article");
      row.className = "purchase-row";
      const item = purchase.order_items?.[0];
      const downloadProduct = window.BookWellCommerceCore.purchaseDownloadProduct(purchase, purchaseProducts);
      const publicProduct = downloadProduct?.status === "published"
        ? downloadProduct
        : item?.product?.status === "published" ? item.product : null;
      addText(row, "strong", downloadProduct?.title || item?.product?.title || "BookWell product");
      addText(row, "span", window.BookWellMarketplaceCore.formatPrice(
        purchase.total_minor, purchase.currency, navigator.language
      ));
      const state = window.BookWellCommerceCore.purchaseState(purchase);
      addText(row, "span", state === "verified" ? "Payment verified" :
        state === "pending" ? "Payment pending verification" :
          state === "failed" ? "Payment failed" :
            state === "cancelled" ? "Checkout cancelled" :
              state === "refunded" ? "Refunded" :
                state === "partially_refunded" ? "Partially refunded" : "Status unavailable");
      addText(row, "span", new Date(purchase.created_at).toLocaleDateString());
      const actions = document.createElement("div");
      actions.className = "purchase-actions";
      if (state === "verified" && publicProduct?.slug) {
        const details = document.createElement("a");
        details.className = "button secondary";
        details.href = "#product/" + encodeURIComponent(publicProduct.slug);
        details.textContent = "Open resource";
        actions.appendChild(details);
      }
      if (state === "verified" && downloadProduct) {
        const download = document.createElement("button");
        download.type = "button";
        download.className = "button";
        download.textContent = "Download";
        download.addEventListener("click", () => {
          if (!window.BookWellMarketplace?.downloadProduct) {
            setStatus("Secure downloads are unavailable until the marketplace script loads.", true);
            return;
          }
          window.BookWellMarketplace.downloadProduct(downloadProduct, {
            onStatus: function (message, isError) { setStatus(message, isError); }
          });
        });
        actions.appendChild(download);
      } else if (state === "verified") {
        const message = purchasesState.loading && !purchasesState.loaded
          ? "Checking current download access…"
          : purchasesState.error && !purchasesState.loaded
            ? "Current download access could not be loaded. Retry My Purchases."
            : purchasesState.hasMore
              ? "This purchase is in an older page. Load more purchases to confirm download access."
              : "Download unavailable: current server-side access could not be confirmed.";
        addText(actions, "span", message, "purchase-unavailable");
      }
      if (actions.childElementCount) row.appendChild(actions);
      elements.purchases.appendChild(row);
    });
  }

  function updatePurchaseReturn(rows, user) {
    const params = new URLSearchParams(window.location.search);
    const requestedOrderId = params.get("order_id");
    const requestedState = params.get("purchase");
    if (!requestedOrderId || !/^[0-9a-f-]{36}$/i.test(requestedOrderId) ||
        !["success", "cancelled"].includes(requestedState)) {
      elements.purchaseStatus.hidden = true;
      if (purchasePollTimer) window.clearTimeout(purchasePollTimer);
      purchasePollTimer = null;
      purchasePolls = 0;
      return;
    }
    const purchase = rows.find((row) => row.id === requestedOrderId);
    elements.purchaseStatus.hidden = false;
    if (!purchase) {
      elements.purchaseStatus.textContent = "This purchase is not available in the signed-in account. Sign in with the account used at checkout.";
      return;
    }
    const state = window.BookWellCommerceCore.purchaseState(purchase);
    if (state === "verified") {
      elements.purchaseStatus.textContent = "Payment verified by BookWell. Your resource is now available in My Library.";
      purchasePolls = 0;
      return;
    }
    if (state === "pending") {
      elements.purchaseStatus.textContent = requestedState === "cancelled"
        ? "Checkout returned without a verified result. Payment status is still pending; BookWell will not grant access until provider verification completes."
        : "We’re waiting for the provider’s verified payment notification. Your resource will appear in My Library only after verification.";
      if (purchasePolls < 12 && !purchasePollTimer) {
        purchasePolls += 1;
        purchasePollTimer = window.setTimeout(() => {
          purchasePollTimer = null;
          if (currentUser?.id === user.id) loadDashboard(user).catch((error) => {
            setStatus(error.message || "Purchase status could not be refreshed.", true);
          });
        }, 2500);
      }
      return;
    }
    elements.purchaseStatus.textContent = state === "failed" ? "The provider reported that this payment failed. No access was granted."
      : state === "cancelled" ? "Checkout was cancelled. No purchase access was granted."
        : state === "refunded" ? "This purchase was refunded and access is no longer available."
          : state === "partially_refunded" ? "This purchase was partially refunded. Access follows BookWell’s verified purchase record."
            : "Purchase status could not be verified. No access has been granted.";
  }

  async function loadDashboard(user) {
    const request = ++dashboardRequest;
    resetLibrarySections();
    beginAccessLoad();
    loadLibrarySection("purchases");
    loadLibrarySection("free");
    loadLibrarySection("additional");
    setStatus("Loading your BookWell account…", false);
    const [profileResult, savedResult, recentResult, purchasesResult] = await Promise.all([
      client.from("user_profiles").select("display_name").eq("user_id", user.id).maybeSingle(),
      client.from("saved_products")
        .select("user_id,created_at,product:products!inner(id,title,slug,description,formats,preview_path,price_minor,currency,status)")
        .eq("user_id", user.id)
        .eq("product.status", "published")
        .order("created_at", { ascending: false }),
      client.from("download_events")
        .select("created_at,product:products!inner(id,title,slug)")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(5),
      client.from("orders")
        .select("id,status,total_minor,currency,created_at,verified_at,order_items(product_id,unit_price_minor,currency,refunded_minor,product:products(id,title,slug))")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50)
    ]);
    if (request !== dashboardRequest || currentUser?.id !== user.id) return;
    const failure = profileResult.error || savedResult.error || recentResult.error || purchasesResult.error;
    if (failure) {
      setStatus("Your account is signed in, but the account database migration is missing or unavailable. Review and apply the BookWell account and paginated-library migrations to a disposable Supabase project.", true);
      return;
    }
    const profile = profileResult.data;
    profileExists = Boolean(profile);
    const savedRows = core.ownPublishedSavedProducts(savedResult.data || [], user.id);
    const recentRows = recentResult.data || [];
    const purchaseRows = purchasesResult.data || [];
    purchaseHistoryRows = purchaseRows;
    savedProductIds = new Set(savedRows.map((row) => row.product.id));
    elements.displayName.value = profile?.display_name || "";
    elements.emailLabel.textContent = user.email || "Email not available";
    elements.welcome.textContent = profile?.display_name
      ? "Welcome, " + profile.display_name
      : "Welcome to your BookWell account";
    elements.savedCount.textContent = String(savedRows.length);
    renderProducts(elements.saved, savedRows, true);
    elements.recent.replaceChildren();
    if (!recentRows.length) {
      addText(elements.recent, "p", "No download links have been issued to this account yet.", "account-empty");
    } else {
      recentRows.forEach((row) => {
        if (!row.product) return;
        const link = document.createElement("a");
        link.href = "#product/" + encodeURIComponent(row.product.slug);
        link.textContent = row.product.title + " · " + new Date(row.created_at).toLocaleDateString();
        elements.recent.appendChild(link);
      });
    }
    renderPurchaseHistory(purchaseRows);
    updatePurchaseReturn(purchaseRows, user);
    syncSaveButtons();
    setStatus("", false);
  }

  function syncSaveButtons() {
    document.querySelectorAll("[data-save-product-id]").forEach((button) => {
      const id = button.dataset.saveProductId;
      const saved = savedProductIds.has(id);
      button.textContent = saved ? "Saved" : "Save";
      button.setAttribute("aria-pressed", String(saved));
      button.disabled = busyProductIds.has(id);
    });
  }

  async function toggleSavedProduct(product) {
    if (!client || !accountClient.configured()) {
      setStatus("Set up Supabase Auth and the public project configuration before saving resources.", true);
      window.location.hash = "#account";
      return;
    }
    if (!core.isSignedIn({ user: currentUser })) {
      try {
        sessionStorage.setItem("bookwell-return-product", product.slug);
      } catch {
        setStatus("Sign in to save this resource. Your browser could not store a return link, so you can reopen the resource from the Library afterward.", false);
      }
      setStatus("Sign in or create a free account to save this resource. You’ll return to it after authentication.", false);
      window.location.hash = "#account";
      return;
    }
    if (!product?.id || busyProductIds.has(product.id)) return;
    busyProductIds.add(product.id);
    syncSaveButtons();
    try {
      const mutation = core.savedProductMutation(
        { user: currentUser }, product.id, savedProductIds.has(product.id)
      );
      const result = mutation.operation === "delete"
        ? await client.from("saved_products").delete()
          .eq("user_id", mutation.record.user_id).eq("product_id", mutation.record.product_id)
        : await client.from("saved_products").insert(mutation.record);
      if (result.error) throw result.error;
      if (mutation.operation === "delete") savedProductIds.delete(product.id);
      else savedProductIds.add(product.id);
      if (!elements.dashboard.hidden) await loadDashboard(currentUser);
      setStatus(savedProductIds.has(product.id) ? "Resource saved to your account." : "Resource removed from saved products.", false);
    } catch (error) {
      setStatus(error.message || "The saved-products list could not be updated.", true);
    } finally {
      busyProductIds.delete(product.id);
      syncSaveButtons();
    }
  }

  async function handleSignIn(event) {
    event.preventDefault();
    if (!client) {
      setStatus("Account access is unavailable. Configure Supabase and make sure the Supabase JavaScript client has loaded.", true);
      return;
    }
    const data = new FormData(elements.signIn);
    setBusy(elements.signIn, true);
    setStatus("Signing in securely…", false);
    try {
      const email = String(data.get("email")).trim();
      const { data: result, error } = await client.auth.signInWithPassword({
        email: email,
        password: String(data.get("password"))
      });
      if (error) throw error;
      if (!isEmailVerified(result.user)) {
        elements.email.value = email;
        await client.auth.signOut();
        throw new Error("Email verification is required before you can use your account.");
      }
      elements.signIn.reset();
      setStatus("You’re signed in.", false);
    } catch (error) {
      setStatus(friendlyAuthError(error), true);
    } finally {
      setBusy(elements.signIn, false);
    }
  }

  async function handleSignUp(event) {
    event.preventDefault();
    if (!client) {
      setStatus("Account access is unavailable. Configure Supabase and make sure the Supabase JavaScript client has loaded.", true);
      return;
    }
    const data = new FormData(elements.signUp);
    if (data.get("password") !== data.get("confirm_password")) {
      setStatus("The passwords do not match.", true);
      return;
    }
    setBusy(elements.signUp, true);
    setStatus("Creating your account…", false);
    try {
      const { data: result, error } = await client.auth.signUp({
        email: String(data.get("email")).trim(),
        password: String(data.get("password")),
        options: { emailRedirectTo: redirectUrl() }
      });
      if (error) throw error;
      elements.email.value = String(data.get("email")).trim();
      elements.signUp.reset();
      showAuthForm(elements.signIn);
      if (!result.session || !isEmailVerified(result.user)) {
        if (result.session) await client.auth.signOut();
        elements.verify.hidden = false;
        setStatus("Check your inbox to verify your email before signing in.", false);
      } else {
        setStatus("Your account is ready. You can now use your BookWell library.", false);
      }
    } catch (error) {
      setStatus(friendlyAuthError(error), true);
    } finally {
      setBusy(elements.signUp, false);
    }
  }

  async function handleForgotPassword(event) {
    event.preventDefault();
    if (!client) {
      setStatus("Configure Supabase Auth before requesting a password reset.", true);
      return;
    }
    const email = String(new FormData(elements.forgot).get("email")).trim();
    setBusy(elements.forgot, true);
    setStatus("Sending password-reset instructions…", false);
    try {
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: core.recoveryRedirectUrl(window.location.href) });
      if (error) throw error;
      setStatus("If an account exists for that address, password-reset instructions have been sent.", false);
    } catch (error) {
      setStatus(friendlyAuthError(error), true);
    } finally {
      setBusy(elements.forgot, false);
    }
  }

  async function handlePasswordReset(event) {
    event.preventDefault();
    const data = new FormData(elements.reset);
    if (data.get("password") !== data.get("confirm_password")) {
      setStatus("The passwords do not match.", true);
      return;
    }
    setBusy(elements.reset, true);
    try {
      const { error } = await client.auth.updateUser({ password: String(data.get("password")) });
      if (error) throw error;
      elements.reset.reset();
      showAuthForm(elements.signIn);
      setStatus("Your password was updated. You’re signed in securely.", false);
    } catch (error) {
      setStatus(friendlyAuthError(error), true);
    } finally {
      setBusy(elements.reset, false);
    }
  }

  async function handleProfileUpdate(event) {
    event.preventDefault();
    if (!currentUser) return;
    const displayName = elements.displayName.value.trim();
    if (displayName.length > 80) {
      setStatus("Your display name must be 80 characters or fewer.", true);
      return;
    }
    setBusy(elements.profile, true, "Saving…");
    try {
      const result = profileExists
        ? await client.from("user_profiles").update({ display_name: displayName }).eq("user_id", currentUser.id)
        : await client.from("user_profiles").insert({ user_id: currentUser.id, display_name: displayName });
      const { error } = result;
      if (error) throw error;
      profileExists = true;
      elements.welcome.textContent = displayName ? "Welcome, " + displayName : "Welcome to your BookWell account";
      setStatus("Your profile was updated.", false);
    } catch (error) {
      setStatus(error.message || "Your profile could not be updated.", true);
    } finally {
      setBusy(elements.profile, false);
    }
  }

  async function signOut() {
    elements.signOut.disabled = true;
    try {
      if (!client) throw new Error("The authentication client is unavailable.");
      const { error } = await client.auth.signOut();
      if (error) throw error;
      setStatus("You have signed out.", false);
    } catch (error) {
      setStatus(error.message || "Sign out could not be completed.", true);
    } finally {
      elements.signOut.disabled = false;
    }
  }

  async function resendVerification() {
    if (!client) return;
    const email = elements.email.value.trim();
    if (!email) {
      setStatus("Enter your email address first, then request another verification message.", true);
      return;
    }
    const button = document.getElementById("account-verification-resend");
    button.disabled = true;
    setStatus("Requesting another verification email…", false);
    try {
      const { error } = await client.auth.resend({
        type: "signup", email, options: { emailRedirectTo: redirectUrl() }
      });
      if (error) throw error;
      setStatus("If that address has an unverified account, a new verification email has been sent.", false);
    } catch (error) {
      setStatus(friendlyAuthError(error), true);
    } finally {
      button.disabled = false;
    }
  }

  elements.signIn.addEventListener("submit", handleSignIn);
  elements.signUp.addEventListener("submit", handleSignUp);
  elements.forgot.addEventListener("submit", handleForgotPassword);
  elements.reset.addEventListener("submit", handlePasswordReset);
  elements.profile.addEventListener("submit", handleProfileUpdate);
  elements.signOut.addEventListener("click", signOut);
  document.getElementById("account-show-signup").addEventListener("click", () => showAuthForm(elements.signUp));
  document.querySelectorAll("[data-account-show-signin]").forEach((button) => {
    button.addEventListener("click", () => showAuthForm(elements.signIn));
  });
  document.getElementById("account-show-forgot").addEventListener("click", () => showAuthForm(elements.forgot));
  document.getElementById("account-verification-resend").addEventListener("click", resendVerification);
  Object.keys(librarySections).forEach((section) => {
    const state = librarySections[section];
    state.more.addEventListener("click", () => loadLibrarySection(section, { append: true }));
    state.retry.addEventListener("click", () => loadLibrarySection(section, { append: state.rows.length > 0 }));
  });
  window.addEventListener("hashchange", () => {
    if (inlineAuthEnabled && location.hash === "#account" && client && authEvent === "PASSWORD_RECOVERY") {
      elements.dashboard.hidden = true;
      elements.auth.hidden = !inlineAuthEnabled;
      elements.reset.hidden = false;
      [elements.signIn, elements.signUp, elements.forgot].forEach((form) => { form.hidden = true; });
    }
  });

  window.BookWellAccount = {
    accessSnapshot: accessSnapshot,
    checkProductAccess: checkProductAccess,
    isSaved: (productId) => savedProductIds.has(productId),
    refreshAccess: refreshAccess,
    toggleSavedProduct: toggleSavedProduct
  };

  const accountAvailability = core.availability(accountClient?.configured(), Boolean(client));
  if (accountAvailability === "not-configured") {
    setStatus("Accounts are being prepared. BookWell’s Supabase project is not configured, so sign-in and saved products are unavailable.", false);
  } else if (accountAvailability === "client-unavailable") {
    setStatus("Account sign-in is unavailable because the Supabase JavaScript client did not load. Check the connection to its pinned CDN asset.", true);
  } else {
    elements.status.textContent = inlineAuthEnabled
      ? "Sign in or create a free account to save resources and build your personal library."
      : "Use the Sign In page to access your BookWell account.";
    client.auth.onAuthStateChange((event, session) => {
      authEvent = event;
      updateAccountNavigation(session);
      if (event === "INITIAL_SESSION" && core.isRecoveryRequest(window.location.search)) {
        window.location.replace(core.recoveryRedirectUrl(window.location.href));
        return;
      }
      if (event === "PASSWORD_RECOVERY" && session && !inlineAuthEnabled) {
        window.location.replace(core.recoveryRedirectUrl(window.location.href));
        return;
      }
      if (session?.user && !isEmailVerified(session.user)) {
        currentUser = null;
        clearAccess();
        elements.email.value = session.user.email || elements.email.value;
        elements.auth.hidden = !inlineAuthEnabled;
        elements.dashboard.hidden = true;
        elements.verify.hidden = false;
        setStatus("Please verify your email before signing in to BookWell.", true);
        window.setTimeout(() => client.auth.signOut().catch(() => {
          setStatus("Your email is not verified. Close this page if the session could not be signed out locally.", true);
        }), 0);
        return;
      }
      currentUser = session?.user || null;
      if (currentUser) beginAccessLoad();
      else clearAccess();
      elements.auth.hidden = !inlineAuthEnabled || Boolean(currentUser);
      elements.dashboard.hidden = !currentUser;
      elements.verify.hidden = true;
      if (event === "PASSWORD_RECOVERY" && session) {
        elements.auth.hidden = !inlineAuthEnabled;
        elements.dashboard.hidden = true;
        elements.reset.hidden = false;
        [elements.signIn, elements.signUp, elements.forgot].forEach((form) => { form.hidden = true; });
        setStatus("Choose a new password for your account.", false);
        return;
      }
      if (currentUser) {
        showAuthForm(elements.signIn);
        window.setTimeout(() => loadDashboard(currentUser).catch((error) => {
          setStatus(error.message || "Your account data could not be loaded.", true);
        }), 0);
        if (event === "SIGNED_IN" || event === "INITIAL_SESSION") {
          let returnSlug = null;
          try {
            returnSlug = sessionStorage.getItem("bookwell-return-product");
            sessionStorage.removeItem("bookwell-return-product");
          } catch {
            returnSlug = null;
          }
          if (returnSlug) window.setTimeout(() => {
            location.hash = "#product/" + encodeURIComponent(returnSlug);
          }, 100);
        }
      } else {
        dashboardRequest += 1;
        savedProductIds = new Set();
        syncSaveButtons();
        if (event === "SIGNED_OUT") setStatus("You have signed out.", false);
      }
    });
  }
})();
