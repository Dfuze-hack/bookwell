(function () {
  "use strict";

  const PAGE_SIZE = 12;
  const core = window.BookWellMarketplaceCore;
  const commerceCore = window.BookWellCommerceCore;
  const config = window.BOOKWELL_CONFIG || {};
  const elements = {
    form: document.getElementById("catalog-filters"),
    heroForm: document.getElementById("hero-search-form"),
    heroSearch: document.getElementById("hero-search"),
    search: document.getElementById("catalog-search"),
    category: document.getElementById("catalog-category"),
    categoryLinks: document.getElementById("catalog-category-links"),
    price: document.getElementById("catalog-price"),
    format: document.getElementById("catalog-format"),
    minPrice: document.getElementById("catalog-min-price"),
    maxPrice: document.getElementById("catalog-max-price"),
    currency: document.getElementById("catalog-currency"),
    sort: document.getElementById("catalog-sort"),
    clear: document.getElementById("catalog-clear"),
    status: document.getElementById("catalog-status"),
    emptyActions: document.getElementById("catalog-empty-actions"),
    diagnostics: document.getElementById("catalog-diagnostics"),
    diagnosticText: document.getElementById("catalog-diagnostic-text"),
    results: document.getElementById("catalog-results"),
    more: document.getElementById("catalog-more"),
    retry: document.getElementById("catalog-retry"),
    dialog: document.getElementById("product-dialog"),
    dialogContent: document.getElementById("product-dialog-content"),
    dialogClose: document.querySelector(".product-dialog-close")
  };
  let offset = 0;
  let requestId = 0;
  let debounceTimer;
  let loadingMore = false;
  let downloading = false;

  function isAllowedSupabaseUrl(value) {
    try {
      const url = new URL(value);
      return (url.protocol === "https:" && /^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) && !url.port) ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "54321");
    } catch {
      return false;
    }
  }

  function configured() {
    return typeof config.supabaseUrl === "string" &&
      isAllowedSupabaseUrl(config.supabaseUrl) &&
      typeof config.supabaseAnonKey === "string" &&
      config.supabaseAnonKey.length > 20;
  }

  function setStatus(message, isError, state) {
    elements.status.textContent = message;
    elements.status.hidden = false;
    elements.status.setAttribute("role", isError ? "alert" : "status");
    elements.retry.hidden = !isError;
    elements.status.className = "catalog-status state-" + (state || (isError ? "error" : "loading"));
    elements.emptyActions.hidden = state !== "empty" && state !== "disconnected";
  }

  function clearStatus() {
    elements.status.hidden = true;
    elements.retry.hidden = true;
    elements.emptyActions.hidden = true;
    elements.diagnostics.hidden = true;
  }

  function money(product) {
    return core.formatPrice(product.price_minor, product.currency, navigator.language);
  }

  function addText(parent, tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text || "";
    if (className) node.className = className;
    parent.appendChild(node);
    return node;
  }

  function addBadge(parent, label, extraClass) {
    addText(parent, "span", label, "product-badge" + (extraClass ? " " + extraClass : ""));
  }

  function saveButton(product) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button secondary";
    button.dataset.saveProductId = product.id;
    const saved = window.BookWellAccount?.isSaved(product.id) || false;
    button.textContent = saved ? "Saved" : "Save";
    button.setAttribute("aria-pressed", String(saved));
    button.addEventListener("click", function () {
      window.BookWellAccount?.toggleSavedProduct(product);
    });
    return button;
  }

  async function setPreviewSource(image, previewPath) {
    if (typeof previewPath !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(png|jpg|webp)$/i.test(previewPath)) {
      throw new Error("The preview image path is invalid.");
    }
    const encodedPath = previewPath.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(
      config.supabaseUrl.replace(/\/$/, "") + "/storage/v1/object/sign/product-previews/" + encodedPath,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: config.supabaseAnonKey,
          Authorization: "Bearer " + config.supabaseAnonKey
        },
        body: JSON.stringify({ expiresIn: 300 })
      }
    );
    if (!response.ok) throw new Error("The preview image could not be authorized.");
    const result = await response.json();
    image.src = core.signedPreviewUrl(
      config.supabaseUrl,
      result.signedURL
    );
  }

  function showPreview(image, previewPath) {
    if (typeof previewPath !== "string") return;
    setPreviewSource(image, previewPath).catch(function () {
      image.alt = "Preview image unavailable";
      setStatus("A preview image could not be loaded. The product listing remains available.", true);
    });
  }

  function renderProduct(product) {
    const card = document.createElement("article");
    card.className = "card product-card";
    card.dataset.slug = product.slug;
    const title = document.createElement("h3");
    title.textContent = product.title;
    if (typeof product.preview_path === "string") {
      const preview = document.createElement("img");
      preview.alt = "";
      preview.loading = "lazy";
      preview.referrerPolicy = "no-referrer";
      preview.className = "product-preview";
      card.appendChild(preview);
      showPreview(preview, product.preview_path);
    } else {
      const cover = addText(card, "div", product.formats[0] || "Learning resource", "product-cover-fallback");
      cover.setAttribute("aria-hidden", "true");
    }
    card.appendChild(title);
    addText(card, "p", product.description, "product-description");

    const metadata = document.createElement("div");
    metadata.className = "product-meta";
    addBadge(metadata, product.category_name);
    if (typeof product.language === "string" && product.language.trim()) addBadge(metadata, product.language);
    if (product.formats.length) addBadge(metadata, product.formats[0]);
    if (product.included_with_premium) addBadge(metadata, "Premium included");
    card.appendChild(metadata);
    if (typeof product.creator_name === "string" && product.creator_name.trim()) {
      addText(card, "p", "By " + product.creator_name.trim(), "product-creator");
    }
    addText(card, "p", money(product), "product-price");

    const actions = document.createElement("div");
    actions.className = "product-actions";
    const details = document.createElement("button");
    details.type = "button";
    details.className = "button secondary";
    details.textContent = "Details";
    details.addEventListener("click", function () {
      openProduct(product);
    });
    actions.appendChild(details);
    actions.appendChild(saveButton(product));
    if (product.price_minor === 0) {
      const download = document.createElement("button");
      download.type = "button";
      download.className = "button";
      download.textContent = "Download";
      download.addEventListener("click", function () {
        downloadProduct(product);
      });
      actions.appendChild(download);
    } else {
      const buy = document.createElement("button");
      buy.type = "button";
      buy.className = "button";
      buy.textContent = "Buy";
      buy.addEventListener("click", function () {
        purchaseProduct(product, buy);
      });
      actions.appendChild(buy);
    }
    card.appendChild(actions);
    elements.results.appendChild(card);
  }

  function renderDetail(product) {
    elements.dialogContent.replaceChildren();
    const heading = addText(elements.dialogContent, "h2", product.title);
    heading.id = "product-dialog-title";
    if (typeof product.preview_path === "string") {
      const preview = document.createElement("img");
      preview.alt = "Preview for " + product.title;
      preview.loading = "lazy";
      preview.referrerPolicy = "no-referrer";
      preview.className = "product-preview product-preview-large";
      elements.dialogContent.appendChild(preview);
      showPreview(preview, product.preview_path);
    }
    addText(elements.dialogContent, "p", product.description);
    addText(elements.dialogContent, "p", "Category: " + product.category_name);
    if (typeof product.language === "string" && product.language.trim()) {
      addText(elements.dialogContent, "p", "Language: " + product.language);
    }
    if (typeof product.creator_name === "string" && product.creator_name.trim()) {
      addText(elements.dialogContent, "p", "Creator: " + product.creator_name.trim());
    }
    addText(elements.dialogContent, "p", "Price: " + money(product), "product-detail-price");
    addText(elements.dialogContent, "p", "Licence: " + product.license);
    addText(elements.dialogContent, "p", "Formats: " + product.formats.join(", "));
    if (product.updated_at) {
      addText(elements.dialogContent, "p", "Last updated: " + new Date(product.updated_at).toLocaleDateString());
    }
    if (product.included_with_premium) addBadge(elements.dialogContent, "Included with BookWell Premium");
    const tags = document.createElement("p");
    tags.textContent = "Tags: " + product.tags.join(", ");
    elements.dialogContent.appendChild(tags);
    const saveActions = document.createElement("div");
    saveActions.className = "product-actions";
    saveActions.appendChild(saveButton(product));
    elements.dialogContent.appendChild(saveActions);
    if (product.price_minor === 0) {
      const download = document.createElement("button");
      download.type = "button";
      download.className = "button";
      download.textContent = "Download free resource";
      download.addEventListener("click", function () {
        downloadProduct(product);
      });
      elements.dialogContent.appendChild(download);
    } else {
      addText(elements.dialogContent, "p", "One-time access to this resource. The private file becomes available only after BookWell verifies payment.");
      const buy = document.createElement("button");
      buy.type = "button";
      buy.className = "button";
      buy.textContent = "Buy " + money(product);
      buy.addEventListener("click", function () {
        purchaseProduct(product, buy);
      });
      elements.dialogContent.appendChild(buy);
    }
  }

  function openProduct(product) {
    renderDetail(product);
    if (!elements.dialog.open) elements.dialog.showModal();
    history.replaceState(null, "", "#product/" + encodeURIComponent(product.slug));
  }

  async function openProductSlug(slug) {
    if (!configured() || elements.dialog.open) return;
    try {
      const response = await fetch(config.supabaseUrl.replace(/\/$/, "") + "/rest/v1/rpc/public_product_by_slug", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: config.supabaseAnonKey,
          Authorization: "Bearer " + config.supabaseAnonKey
        },
        body: JSON.stringify({ p_slug: slug })
      });
      if (!response.ok) throw new Error("This resource could not be loaded.");
      const products = await response.json();
      if (!Array.isArray(products) || products.length === 0) throw new Error("This resource is unavailable or has not been published.");
      renderDetail(products[0]);
      elements.dialog.showModal();
    } catch (error) {
      setStatus(error.message || "This resource could not be loaded. Please try again.", true);
    }
  }

  function closeProduct() {
    if (elements.dialog.open) elements.dialog.close();
    if (location.hash.startsWith("#product/")) {
      history.replaceState(null, "", "#library");
    }
  }

  async function downloadProduct(product) {
    if (downloading) return;
    if (!configured()) {
      setStatus("Downloads are unavailable until the BookWell catalog and secure-download service are configured.", true);
      return;
    }
    downloading = true;
    setStatus("Checking download access…", false);
    try {
      async function getSignedDownloadUrl() {
        const accessToken = await window.BookWellAccountClient?.getAccessToken();
        const response = await fetch(config.supabaseUrl.replace(/\/$/, "") + "/functions/v1/create-download", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: config.supabaseAnonKey,
            Authorization: "Bearer " + (accessToken || config.supabaseAnonKey)
          },
          body: JSON.stringify({ productId: product.id })
        });
        let result = {};
        try {
          result = await response.json();
        } catch {
          throw new Error("The secure download service returned an invalid response.");
        }
        if (!response.ok || typeof result.url !== "string" ||
            !["pdf", "zip", "docx", "pptx", "xlsx"].includes(result.extension)) {
          throw new Error(result.error || "This download is not available for your account.");
        }
        return { url: result.url, extension: result.extension };
      }
      let issuedLink = await getSignedDownloadUrl();
      let downloadResponse = await fetch(issuedLink.url);
      if (core.shouldRefreshDownload(downloadResponse)) {
        issuedLink = await getSignedDownloadUrl();
        downloadResponse = await fetch(issuedLink.url);
      }
      if (!downloadResponse.ok) {
        throw new Error("The download failed or its temporary link expired. Please retry.");
      }
      const objectUrl = URL.createObjectURL(await downloadResponse.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = product.slug + "." + issuedLink.extension;
      link.hidden = true;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      clearStatus();
    } catch (error) {
      setStatus(error.message || "The download failed. Please retry.", true);
    } finally {
      downloading = false;
    }
  }

  async function purchaseProduct(product, button) {
    if (!product || !product.id || product.price_minor <= 0) {
      setStatus("This product is not available for purchase.", true);
      return;
    }
    const accessToken = await window.BookWellAccountClient?.getAccessToken().catch(() => null);
    if (!accessToken) {
      try {
        sessionStorage.setItem("bookwell-return-product", product.slug);
      } catch {
        setStatus("Sign in before purchasing. You can reopen this resource from the Library afterward.", false);
      }
      window.location.hash = "#account";
      setStatus("Sign in or create an account to continue to checkout. You’ll return to this resource afterward.", false);
      return;
    }
    if (!configured()) {
      setStatus("Secure checkout is not configured. No payment has been taken.", true);
      return;
    }
    if (button) {
      button.disabled = true;
      button.textContent = "Preparing secure checkout…";
    }
    setStatus("Preparing secure checkout…", false);
    try {
      const response = await fetch(config.supabaseUrl.replace(/\/$/, "") + "/functions/v1/create-checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: config.supabaseAnonKey,
          Authorization: "Bearer " + accessToken
        },
        body: JSON.stringify({ productId: product.id, requestId: crypto.randomUUID() })
      });
      let result = {};
      try {
        result = await response.json();
      } catch {
        throw new Error("The checkout service returned an invalid response.");
      }
      if (!response.ok) {
        if (result.code === "already_owned" || result.status === "already_owned") {
          setStatus("You already have access to this resource. It is available in My Library.", false);
          return;
        }
        throw new Error(result.error || "Secure checkout is currently unavailable. No payment has been taken.");
      }
      const checkoutUrl = commerceCore.checkoutUrl(result.checkoutUrl);
      if (typeof result.orderId !== "string") throw new Error("The checkout service returned an invalid purchase reference.");
      window.location.assign(checkoutUrl);
    } catch (error) {
      setStatus(error.message || "Secure checkout is currently unavailable. No payment has been taken.", true);
    } finally {
      if (button?.isConnected) {
        button.disabled = false;
        button.textContent = "Buy " + money(product);
      }
    }
  }

  async function loadCategories() {
    while (elements.category.options.length > 1) elements.category.remove(1);
    const url = config.supabaseUrl.replace(/\/$/, "") +
      "/rest/v1/categories?select=name,slug&is_active=eq.true&order=name.asc";
    const response = await fetch(url, {
      headers: { apikey: config.supabaseAnonKey, Authorization: "Bearer " + config.supabaseAnonKey }
    });
    if (!response.ok) throw new Error("Categories could not be loaded.");
    const categories = await response.json();
    elements.categoryLinks.replaceChildren();
    if (categories.length) {
      const allButton = document.createElement("button");
      allButton.type = "button";
      allButton.textContent = "All topics";
      allButton.dataset.categorySlug = "";
      allButton.setAttribute("aria-pressed", "true");
      elements.categoryLinks.appendChild(allButton);
      categories.forEach(function (category) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = category.name;
        button.dataset.categorySlug = category.slug;
        button.setAttribute("aria-pressed", "false");
        elements.categoryLinks.appendChild(button);
      });
      elements.categoryLinks.hidden = false;
    } else {
      elements.categoryLinks.hidden = true;
    }
    categories.forEach(function (category) {
      const option = document.createElement("option");
      option.value = category.slug;
      option.textContent = category.name;
      elements.category.appendChild(option);
    });
  }

  function syncCategoryLinks() {
    elements.categoryLinks.querySelectorAll("button").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.categorySlug === elements.category.value));
    });
  }

  async function loadProducts(append) {
    if (!configured()) {
      elements.results.hidden = true;
      elements.more.hidden = true;
      const hasValues = Boolean(config.supabaseUrl || config.supabaseAnonKey);
      setStatus(
        "We’re preparing the BookWell library. Please check back soon as learning resources are added.",
        false,
        "disconnected"
      );
      elements.diagnostics.hidden = false;
      elements.diagnosticText.textContent = hasValues
        ? "Catalogue diagnostics: the configured Supabase URL or public anon key is invalid or incomplete."
        : "Catalogue diagnostics: no Supabase project URL/public anon key is configured. No sample products are displayed.";
      return;
    }
    if (append && loadingMore) return;
    if (!append) offset = 0;
    const currentRequest = ++requestId;
    let parameters;
    try {
      parameters = core.buildSearchParameters({
        search: elements.search.value,
        category: elements.category.value,
        priceType: elements.price.value,
        fileFormat: elements.format.value,
        currency: elements.currency.value,
        sort: elements.sort.value,
        minPrice: elements.minPrice.value,
        maxPrice: elements.maxPrice.value
      }, PAGE_SIZE, offset);
    } catch (error) {
      setStatus(error.message, true);
      elements.diagnostics.hidden = false;
      elements.diagnosticText.textContent = error.message;
      elements.retry.hidden = true;
      return;
    }
    if (!append) {
      elements.results.replaceChildren();
      elements.results.hidden = true;
      elements.more.hidden = true;
      setStatus("Loading the published catalog…", false);
    } else {
      loadingMore = true;
      elements.more.disabled = true;
      elements.more.textContent = "Loading…";
    }
    try {
      const response = await fetch(config.supabaseUrl.replace(/\/$/, "") + "/rest/v1/rpc/search_public_products", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: config.supabaseAnonKey,
          Authorization: "Bearer " + config.supabaseAnonKey
        },
        body: JSON.stringify(parameters)
      });
      if (!response.ok) throw new Error("The product catalog could not be loaded.");
      const products = core.validateCatalogueRows(await response.json());
      if (currentRequest !== requestId) return;
      const hasMore = products.length > PAGE_SIZE;
      products.slice(0, PAGE_SIZE).forEach(renderProduct);
      offset += Math.min(products.length, PAGE_SIZE);
      elements.results.hidden = elements.results.childElementCount === 0;
      elements.more.hidden = !hasMore;
      if (offset === 0) {
        const hasFilters = Boolean(parameters.p_search || parameters.p_category || parameters.p_file_format ||
          parameters.p_price_type || parameters.p_min_price_minor !== null || parameters.p_max_price_minor !== null);
        const message = hasFilters
            ? "No resources match those filters yet. Try changing or clearing your filters."
            : "The library is taking shape. Check back soon for new learning resources.";
        setStatus(message, false, "empty");
      } else {
        clearStatus();
      }
    } catch (error) {
      if (currentRequest !== requestId) return;
      setStatus("We couldn’t load the library just now. Check your connection and try again.", true, "error");
      elements.diagnostics.hidden = false;
      elements.diagnosticText.textContent = error.message || "The catalogue request failed.";
    } finally {
      if (append) {
        loadingMore = false;
        elements.more.disabled = false;
        elements.more.textContent = "Load more";
      }
    }
  }

  elements.form.addEventListener("submit", function (event) {
    event.preventDefault();
    window.clearTimeout(debounceTimer);
    loadProducts(false);
  });
  elements.heroForm.addEventListener("submit", function (event) {
    event.preventDefault();
    elements.search.value = elements.heroSearch.value.trim();
    window.location.hash = "#library";
    loadProducts(false);
    elements.search.focus();
  });
  elements.categoryLinks.addEventListener("click", function (event) {
    const button = event.target.closest("button[data-category-slug]");
    if (!button) return;
    elements.category.value = button.dataset.categorySlug;
    syncCategoryLinks();
    loadProducts(false);
  });
  elements.form.addEventListener("input", function (event) {
    if (event.target === elements.search || event.target === elements.minPrice || event.target === elements.maxPrice) {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(function () { loadProducts(false); }, 300);
    }
  });
  elements.form.addEventListener("change", function (event) {
    if (event.target !== elements.search) {
      syncCategoryLinks();
      loadProducts(false);
    }
  });
  function updatePriceSteps() {
    if (!elements.currency.value) {
      elements.minPrice.step = "any";
      elements.maxPrice.step = "any";
      return;
    }
    const digits = new Intl.NumberFormat(navigator.language, {
      style: "currency",
      currency: elements.currency.value
    }).resolvedOptions().maximumFractionDigits;
    const step = digits ? "0." + "0".repeat(Math.max(digits - 1, 0)) + "1" : "1";
    elements.minPrice.step = step;
    elements.maxPrice.step = step;
  }
  elements.currency.addEventListener("change", updatePriceSteps);
  updatePriceSteps();
  elements.more.addEventListener("click", function () { loadProducts(true); });
  elements.clear.addEventListener("click", function () {
    elements.form.reset();
    updatePriceSteps();
    loadProducts(false);
  });
  elements.retry.addEventListener("click", initializeCatalog);
  elements.dialogClose.addEventListener("click", closeProduct);
  elements.dialog.addEventListener("click", function (event) {
    if (event.target === elements.dialog) closeProduct();
  });
  elements.dialog.addEventListener("close", function () {
    if (location.hash.startsWith("#product/")) history.replaceState(null, "", "#library");
  });
  window.addEventListener("hashchange", function () {
    const match = location.hash.match(/^#product\/([a-z0-9-]+)$/);
    if (match) openProductSlug(match[1]);
  });

  async function initializeCatalog() {
    if (!configured()) {
      loadProducts(false);
      return;
    }
    try {
      await loadCategories();
      await loadProducts(false);
    } catch (error) {
      setStatus("We couldn’t connect to the resource library. Please try again in a moment.", true, "error");
      elements.diagnostics.hidden = false;
      elements.diagnosticText.textContent = error.message || "The catalogue setup could not be reached.";
    }
  }

  initializeCatalog();
  window.BookWellMarketplace = {
    downloadProduct: downloadProduct,
    openProduct: openProduct,
    purchaseProduct: purchaseProduct,
    showPreview: showPreview
  };
  const initialProduct = location.hash.match(/^#product\/([a-z0-9-]+)$/);
  if (initialProduct) openProductSlug(initialProduct[1]);
})();
