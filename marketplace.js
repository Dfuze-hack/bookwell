(function () {
  "use strict";

  const PAGE_SIZE = 12;
  const DISCOVERY_LIMIT = 40;
  const PREFERENCES_KEY = "bookwell-discovery-interests";
  const RECENT_PRODUCTS_KEY = "bookwell-recent-products";
  const SEARCH_QUERY_KEY = "bookwell-catalog-search";
  const core = window.BookWellMarketplaceCore;
  const commerceCore = window.BookWellCommerceCore;
  const config = window.BOOKWELL_CONFIG || {};
  const elements = {
    form: document.getElementById("catalog-filters"),
    heroForm: document.getElementById("hero-search-form"),
    heroSearch: document.getElementById("hero-search"),
    search: document.getElementById("catalog-search"),
    category: document.getElementById("catalog-category"),
    language: document.getElementById("catalog-language"),
    categoryLinks: document.getElementById("catalog-category-links"),
    heroTopics: document.querySelector(".hero-topics"),
    featuredCategoryLinks: document.getElementById("featured-category-links"),
    featuredEmptyState: document.getElementById("featured-empty-state"),
    interestOptions: document.getElementById("discovery-interests"),
    interestSave: document.getElementById("discovery-save-interests"),
    interestClear: document.getElementById("discovery-clear-interests"),
    preferenceStatus: document.getElementById("discovery-preferences-status"),
    discoveryStatus: document.getElementById("discovery-status"),
    recommendations: document.getElementById("recommended-results"),
    recommendationsEmpty: document.getElementById("recommended-empty"),
    recentlyAdded: document.getElementById("recently-added-results"),
    recentlyAddedEmpty: document.getElementById("recently-added-empty"),
    recentlyViewed: document.getElementById("recently-viewed-results"),
    recentlyViewedEmpty: document.getElementById("recently-viewed-empty"),
    suggestions: document.getElementById("discovery-search-suggestions"),
    activeFilters: document.getElementById("catalog-active-filters"),
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
  let discoveryProducts = [];
  let discoveryLoaded = false;
  let recentlyViewedRequestId = 0;
  let categories = [];

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

  async function publicRpc(name, parameters, failureMessage) {
    const response = await fetch(config.supabaseUrl.replace(/\/$/, "") + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.supabaseAnonKey,
        Authorization: "Bearer " + config.supabaseAnonKey
      },
      body: JSON.stringify(parameters || {})
    });
    if (!response.ok) throw new Error(failureMessage);
    try {
      return await response.json();
    } catch {
      throw new Error("The public catalog returned an invalid response.");
    }
  }

  function readLocalList(key) {
    try {
      const value = JSON.parse(window.localStorage.getItem(key) || "[]");
      return Array.isArray(value) ? value : [];
    } catch (error) {
      elements.preferenceStatus.textContent = "This browser could not read saved discovery preferences. The catalog is still available.";
      return [];
    }
  }

  function saveLocalList(key, values) {
    try {
      window.localStorage.setItem(key, JSON.stringify(values));
      return true;
    } catch (error) {
      elements.preferenceStatus.textContent = "This browser could not save discovery preferences. You can still browse the catalog.";
      return false;
    }
  }

  function savedInterests() {
    return readLocalList(PREFERENCES_KEY).filter(function (value) {
      return typeof value === "string";
    });
  }

  function recentSlugs() {
    return readLocalList(RECENT_PRODUCTS_KEY).filter(function (value) {
      return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
    }).slice(0, 8);
  }

  function persistedSearch() {
    try {
      return window.sessionStorage.getItem(SEARCH_QUERY_KEY) || "";
    } catch (error) {
      elements.discoveryStatus.textContent = "Search will work, but this browser cannot remember your query between page sections.";
      return "";
    }
  }

  function rememberSearch(value) {
    try {
      window.sessionStorage.setItem(SEARCH_QUERY_KEY, value);
    } catch (error) {
      elements.discoveryStatus.textContent = "Search is working, but this browser cannot remember the query between page sections.";
    }
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

  function renderProduct(product, target) {
    const destination = target || elements.results;
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
    if (target === elements.recentlyAdded && product.created_at) {
      const createdAt = Date.parse(product.created_at);
      if (Number.isFinite(createdAt)) {
        addText(card, "p", "Added " + new Date(createdAt).toLocaleDateString(), "product-creator");
      }
    }
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
    destination.appendChild(card);
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
    const related = document.createElement("section");
    related.id = "product-related";
    const relatedTitle = addText(related, "h3", "Related resources");
    relatedTitle.id = "product-related-title";
    const relatedStatus = addText(related, "p", "Finding resources with a similar subject, language, or format.", "discovery-caption");
    const relatedGrid = document.createElement("div");
    relatedGrid.className = "grid discovery-products";
    relatedGrid.hidden = true;
    related.appendChild(relatedGrid);
    elements.dialogContent.appendChild(related);
    loadRelatedProducts(product, related, relatedStatus, relatedGrid);
  }

  async function loadRelatedProducts(product, section, status, grid) {
    if (!configured()) {
      status.textContent = "Related resources will be available when the public catalog is connected.";
      return;
    }
    try {
      const products = core.validateCatalogueRows(await publicRpc("related_public_products", {
        target_product: product.id,
        p_limit: 4
      }, "Related resources could not be loaded."));
      if (!section.isConnected || !elements.dialogContent.contains(section)) return;
      if (!products.length) {
        status.textContent = "No closely related published resources are available yet.";
        return;
      }
      status.hidden = true;
      products.forEach(function (relatedProduct) {
        renderProduct(relatedProduct, grid);
      });
      grid.hidden = false;
    } catch (error) {
      if (!section.isConnected || !elements.dialogContent.contains(section)) return;
      status.textContent = "Related resources could not be loaded. Please try again later.";
      status.setAttribute("role", "status");
    }
  }

  function rememberProduct(product) {
    const slugs = [product.slug].concat(recentSlugs().filter(function (slug) {
      return slug !== product.slug;
    })).slice(0, 8);
    saveLocalList(RECENT_PRODUCTS_KEY, slugs);
    loadRecentlyViewed();
  }

  function openProduct(product) {
    rememberProduct(product);
    renderDetail(product);
    if (!elements.dialog.open) elements.dialog.showModal();
    history.replaceState(null, "", "#product/" + encodeURIComponent(product.slug));
  }

  async function publicProductBySlug(slug) {
    const products = core.validateCatalogueRows(await publicRpc(
      "public_product_by_slug",
      { p_slug: slug },
      "This resource could not be loaded."
    ));
    if (!products.length) throw new Error("This resource is unavailable or has not been published.");
    return products[0];
  }

  async function openProductSlug(slug) {
    if (!configured() || elements.dialog.open) return;
    try {
      const product = await publicProductBySlug(slug);
      rememberProduct(product);
      renderDetail(product);
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
    const results = await Promise.all([
      publicRpc("browse_public_categories", {}, "Published subjects could not be loaded."),
      publicRpc("browse_public_languages", {}, "Published languages could not be loaded.")
    ]);
    categories = results[0];
    const languages = results[1];
    if (!Array.isArray(categories) || !Array.isArray(languages)) {
      throw new Error("The catalog returned invalid discovery filters.");
    }
    while (elements.category.options.length > 1) elements.category.remove(1);
    while (elements.language.options.length > 1) elements.language.remove(1);
    elements.categoryLinks.replaceChildren();
    elements.featuredCategoryLinks.replaceChildren();
    elements.interestOptions.replaceChildren();
    const activeInterests = new Set(savedInterests());
    if (categories.length) {
      const allButton = document.createElement("button");
      allButton.type = "button";
      allButton.textContent = "All topics";
      allButton.dataset.categorySlug = "";
      allButton.setAttribute("aria-pressed", "true");
      elements.categoryLinks.appendChild(allButton);
      categories.forEach(function (category) {
        if (typeof category.name !== "string" || typeof category.slug !== "string" ||
            !Number.isSafeInteger(Number(category.product_count)) || Number(category.product_count) < 1) {
          throw new Error("The catalog returned an invalid subject.");
        }
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = category.name + " · " + category.product_count;
        button.dataset.categorySlug = category.slug;
        button.setAttribute("aria-pressed", "false");
        elements.categoryLinks.appendChild(button);

        const featuredButton = document.createElement("button");
        featuredButton.type = "button";
        featuredButton.dataset.categorySlug = category.slug;
        featuredButton.setAttribute("aria-pressed", "false");
        const categoryName = document.createElement("span");
        categoryName.className = "featured-category-name";
        categoryName.textContent = category.name;
        const action = document.createElement("span");
        action.className = "featured-category-action";
        action.textContent = "Explore resources";
        featuredButton.append(categoryName, action);
        elements.featuredCategoryLinks.appendChild(featuredButton);

        const option = document.createElement("option");
        option.value = category.slug;
        option.textContent = category.name;
        elements.category.appendChild(option);

        const interestLabel = document.createElement("label");
        interestLabel.className = "interest-choice";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = category.name;
        checkbox.checked = activeInterests.has(category.name);
        const interestName = document.createElement("span");
        interestName.textContent = category.name;
        interestLabel.append(checkbox, interestName);
        elements.interestOptions.appendChild(interestLabel);
      });
      elements.categoryLinks.hidden = false;
      elements.heroTopics.hidden = false;
      elements.featuredCategoryLinks.hidden = false;
      elements.featuredEmptyState.hidden = true;
    } else {
      elements.categoryLinks.hidden = true;
      elements.heroTopics.hidden = true;
      elements.featuredCategoryLinks.hidden = true;
      elements.featuredEmptyState.hidden = false;
    }
    languages.forEach(function (item) {
      if (!item || typeof item.language !== "string" || !item.language.trim()) {
        throw new Error("The catalog returned an invalid language.");
      }
      const option = document.createElement("option");
      option.value = item.language;
      option.textContent = item.language;
      elements.language.appendChild(option);
    });
    elements.preferenceStatus.textContent = activeInterests.size
      ? "Your selected interests are saved only in this browser."
      : "Interests are optional and stored only in this browser.";
  }

  function syncCategoryLinks() {
    document.querySelectorAll("#catalog-category-links button, #featured-category-links button").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.categorySlug === elements.category.value));
    });
  }

  function selectCategory(event) {
    const button = event.target.closest("button[data-category-slug]");
    if (!button) return;
    elements.category.value = button.dataset.categorySlug;
    syncCategoryLinks();
    window.location.hash = "#library";
    loadProducts(false);
  }

  function renderDiscoverySections() {
    if (!discoveryLoaded) return;
    const recommendationList = core.rankRecommendations(discoveryProducts, {
      categories: savedInterests(),
      search: elements.search.value.trim(),
      recentlyViewed: recentSlugs()
    }, 4);
    elements.recommendations.replaceChildren();
    recommendationList.forEach(function (product) {
      renderProduct(product, elements.recommendations);
    });
    elements.recommendations.hidden = recommendationList.length === 0;
    elements.recommendationsEmpty.hidden = recommendationList.length !== 0;

    const newest = discoveryProducts.slice().sort(function (a, b) {
      return Date.parse(b.created_at || "") - Date.parse(a.created_at || "");
    }).slice(0, 4);
    elements.recentlyAdded.replaceChildren();
    newest.forEach(function (product) {
      renderProduct(product, elements.recentlyAdded);
    });
    elements.recentlyAdded.hidden = newest.length === 0;
    elements.recentlyAddedEmpty.hidden = newest.length !== 0;
    renderSearchSuggestions(discoveryProducts);
    elements.discoveryStatus.textContent = discoveryProducts.length
      ? "Recommendations use your optional subject choices, search words, and published listing metadata. No popularity or sales signals are used."
      : "Discovery sections appear when published resources are available.";
  }

  function renderSearchSuggestions(products) {
    const values = new Set();
    products.forEach(function (product) {
      [product.title, product.category_name, product.language]
        .concat(product.tags || [])
        .forEach(function (value) {
          if (typeof value === "string" && value.trim()) values.add(value.trim());
        });
    });
    elements.suggestions.replaceChildren();
    Array.from(values).slice(0, 30).forEach(function (value) {
      const option = document.createElement("option");
      option.value = value;
      elements.suggestions.appendChild(option);
    });
  }

  async function loadDiscoveryCatalog() {
    const parameters = core.buildSearchParameters({
      search: "",
      category: "",
      language: "",
      priceType: "",
      fileFormat: "",
      currency: "",
      sort: "newest",
      minPrice: "",
      maxPrice: ""
    }, DISCOVERY_LIMIT, 0);
    const products = core.validateCatalogueRows(await publicRpc(
      "search_public_products",
      parameters,
      "Discovery recommendations could not be loaded."
    ));
    discoveryProducts = products.slice(0, DISCOVERY_LIMIT);
    discoveryLoaded = true;
    renderDiscoverySections();
  }

  async function loadRecentlyViewed() {
    const currentRequest = ++recentlyViewedRequestId;
    const slugs = recentSlugs();
    if (!configured()) {
      elements.recentlyViewed.hidden = true;
      elements.recentlyViewedEmpty.hidden = false;
      return;
    }
    if (!slugs.length) {
      elements.recentlyViewed.replaceChildren();
      elements.recentlyViewed.hidden = true;
      elements.recentlyViewedEmpty.hidden = false;
      return;
    }
    elements.recentlyViewedEmpty.textContent = "Refreshing your recently viewed listings…";
    elements.recentlyViewedEmpty.hidden = false;
    elements.recentlyViewed.hidden = true;
    try {
      const results = await Promise.all(slugs.map(function (slug) {
        return publicRpc("public_product_by_slug", { p_slug: slug }, "Recently viewed products could not be refreshed.");
      }));
      const products = results.reduce(function (list, rows) {
        core.validateCatalogueRows(rows);
        if (rows.length) list.push(rows[0]);
        return list;
      }, []);
      const latestSlugs = recentSlugs();
      if (currentRequest !== recentlyViewedRequestId ||
          slugs.length !== latestSlugs.length ||
          slugs.some(function (slug, index) { return slug !== latestSlugs[index]; })) return;
      const visibleSlugs = products.map(function (product) { return product.slug; });
      if (visibleSlugs.length !== slugs.length) saveLocalList(RECENT_PRODUCTS_KEY, visibleSlugs);
      elements.recentlyViewed.replaceChildren();
      products.forEach(function (product) {
        renderProduct(product, elements.recentlyViewed);
      });
      elements.recentlyViewed.hidden = products.length === 0;
      elements.recentlyViewedEmpty.textContent = products.length
        ? ""
        : "Products you open will appear here on this device.";
      elements.recentlyViewedEmpty.hidden = products.length !== 0;
    } catch (error) {
      if (currentRequest !== recentlyViewedRequestId) return;
      elements.recentlyViewedEmpty.textContent = "Recently viewed listings could not be refreshed. Retry the catalog connection to try again.";
      elements.recentlyViewedEmpty.hidden = false;
    }
  }

  function renderActiveFilters() {
    const filters = [
      ["search", elements.search.value.trim() && ["Search: " + elements.search.value.trim(), elements.search]],
      ["category", elements.category.value && ["Subject: " + (elements.category.selectedOptions[0]?.textContent || elements.category.value), elements.category]],
      ["language", elements.language.value && ["Language: " + elements.language.value, elements.language]],
      ["price", elements.price.value && ["Price: " + elements.price.selectedOptions[0].textContent, elements.price]],
      ["format", elements.format.value && ["Format: " + elements.format.value, elements.format]],
      ["minPrice", elements.minPrice.value && ["Minimum: " + elements.currency.value + " " + elements.minPrice.value, elements.minPrice]],
      ["maxPrice", elements.maxPrice.value && ["Maximum: " + elements.currency.value + " " + elements.maxPrice.value, elements.maxPrice]]
    ].filter(function (item) { return Boolean(item[1]); });
    elements.activeFilters.replaceChildren();
    elements.activeFilters.hidden = filters.length === 0;
    if (!filters.length) return;
    addText(elements.activeFilters, "span", "Active filters:", "active-filters-label");
    filters.forEach(function (item) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "active-filter-chip";
      button.dataset.filterKey = item[0];
      button.setAttribute("aria-label", "Remove " + item[1][0]);
      button.textContent = item[1][0] + " ×";
      elements.activeFilters.appendChild(button);
    });
  }

  function clearOneFilter(key) {
    const fields = {
      search: elements.search,
      category: elements.category,
      language: elements.language,
      price: elements.price,
      format: elements.format,
      minPrice: elements.minPrice,
      maxPrice: elements.maxPrice
    };
    const field = fields[key];
    if (!field) return;
    field.value = "";
    if (key === "search") {
      elements.heroSearch.value = "";
      rememberSearch("");
    }
    if ((key === "minPrice" || key === "maxPrice") &&
        !elements.minPrice.value && !elements.maxPrice.value) elements.currency.value = "";
    if (key === "category") syncCategoryLinks();
    updatePriceSteps();
    renderActiveFilters();
    loadProducts(false);
  }

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
    renderActiveFilters();
    try {
      parameters = core.buildSearchParameters({
        search: elements.search.value,
        category: elements.category.value,
        language: elements.language.value,
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
      if (discoveryLoaded) renderDiscoverySections();
      offset += Math.min(products.length, PAGE_SIZE);
      elements.results.hidden = elements.results.childElementCount === 0;
      elements.more.hidden = !hasMore;
      if (offset === 0) {
        const hasFilters = Boolean(parameters.p_search || parameters.p_category || parameters.p_file_format ||
          parameters.p_language || parameters.p_price_type ||
          parameters.p_min_price_minor !== null || parameters.p_max_price_minor !== null);
        const message = hasFilters
            ? "No resources match those filters yet. Remove a filter or clear all filters to broaden your search."
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
    rememberSearch(elements.search.value.trim());
    elements.heroSearch.value = elements.search.value.trim();
    loadProducts(false);
  });
  elements.heroForm.addEventListener("submit", function (event) {
    event.preventDefault();
    elements.search.value = elements.heroSearch.value.trim();
    rememberSearch(elements.search.value);
    window.location.hash = "#library";
    renderActiveFilters();
    loadProducts(false);
    elements.search.focus();
  });
  elements.categoryLinks.addEventListener("click", selectCategory);
  elements.featuredCategoryLinks.addEventListener("click", selectCategory);
  elements.form.addEventListener("input", function (event) {
    if (event.target === elements.search || event.target === elements.minPrice || event.target === elements.maxPrice) {
      if (event.target === elements.search) {
        elements.heroSearch.value = elements.search.value;
        rememberSearch(elements.search.value.trim());
      }
      renderActiveFilters();
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(function () { loadProducts(false); }, 300);
    }
  });
  elements.form.addEventListener("change", function (event) {
    if (event.target !== elements.search) {
      syncCategoryLinks();
      renderActiveFilters();
      if (event.target === elements.currency) updatePriceSteps();
      loadProducts(false);
    }
  });
  elements.search.value = persistedSearch();
  elements.heroSearch.value = elements.search.value;
  updatePriceSteps();
  elements.more.addEventListener("click", function () { loadProducts(true); });
  elements.clear.addEventListener("click", function () {
    elements.form.reset();
    updatePriceSteps();
    elements.heroSearch.value = "";
    rememberSearch("");
    syncCategoryLinks();
    renderActiveFilters();
    loadProducts(false);
  });
  elements.activeFilters.addEventListener("click", function (event) {
    const button = event.target.closest("button[data-filter-key]");
    if (button) clearOneFilter(button.dataset.filterKey);
  });
  elements.interestSave.addEventListener("click", function () {
    const selected = Array.from(elements.interestOptions.querySelectorAll('input[type="checkbox"]:checked'))
      .map(function (checkbox) { return checkbox.value; });
    if (saveLocalList(PREFERENCES_KEY, selected)) {
      elements.preferenceStatus.textContent = selected.length
        ? "Your interests are saved only in this browser."
        : "No interests selected. Recommendations will use recent listings and your current search.";
      renderDiscoverySections();
    }
  });
  elements.interestClear.addEventListener("click", function () {
    elements.interestOptions.querySelectorAll('input[type="checkbox"]').forEach(function (checkbox) {
      checkbox.checked = false;
    });
    if (saveLocalList(PREFERENCES_KEY, [])) {
      elements.preferenceStatus.textContent = "Interests cleared. Recommendations will use recent listings and your current search.";
      renderDiscoverySections();
    }
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
      elements.discoveryStatus.textContent = "Discovery, categories, and personalized recommendations need a configured Supabase catalog.";
      elements.recommendations.hidden = true;
      elements.recommendationsEmpty.textContent = "Recommendations will appear when published resources are available.";
      elements.recommendationsEmpty.hidden = false;
      elements.recentlyAdded.hidden = true;
      elements.recentlyAddedEmpty.textContent = "Recently added resources will appear when the public catalog is connected.";
      elements.recentlyAddedEmpty.hidden = false;
      return;
    }
    try {
      await loadCategories();
      await loadProducts(false);
      if (!discoveryLoaded) await loadDiscoveryCatalog();
      await loadRecentlyViewed();
    } catch (error) {
      setStatus("We couldn’t connect to the resource library. Please try again in a moment.", true, "error");
      elements.diagnostics.hidden = false;
      elements.diagnosticText.textContent = error.message || "The catalogue setup could not be reached.";
      elements.discoveryStatus.textContent = "Discovery data could not be loaded. Check the catalog connection and retry.";
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
