(function () {
  "use strict";

  const PAGE_SIZE = 12;
  const core = window.BookWellMarketplaceCore;
  const config = window.BOOKWELL_CONFIG || {};
  const elements = {
    form: document.getElementById("catalog-filters"),
    search: document.getElementById("catalog-search"),
    category: document.getElementById("catalog-category"),
    price: document.getElementById("catalog-price"),
    format: document.getElementById("catalog-format"),
    minPrice: document.getElementById("catalog-min-price"),
    maxPrice: document.getElementById("catalog-max-price"),
    sort: document.getElementById("catalog-sort"),
    status: document.getElementById("catalog-status"),
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

  function setStatus(message, isError) {
    elements.status.textContent = message;
    elements.status.hidden = false;
    elements.status.setAttribute("role", isError ? "alert" : "status");
    elements.retry.hidden = !isError;
  }

  function clearStatus() {
    elements.status.hidden = true;
    elements.retry.hidden = true;
  }

  function money(product) {
    if (product.price_minor === 0) return "Free";
    const amount = product.price_minor / 100;
    const currency = product.currency || "INR";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency
      }).format(amount);
    } catch {
      return currency + " " + amount.toFixed(2);
    }
  }

  function addText(parent, tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text || "";
    if (className) node.className = className;
    parent.appendChild(node);
    return node;
  }

  function addBadge(parent, label) {
    addText(parent, "span", label, "product-badge");
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
    addText(card, "h3", product.title);
    if (typeof product.preview_path === "string") {
      const preview = document.createElement("img");
      preview.alt = "";
      preview.loading = "lazy";
      preview.referrerPolicy = "no-referrer";
      preview.className = "product-preview";
      card.insertBefore(preview, card.children[1]);
      showPreview(preview, product.preview_path);
    }
    addText(card, "p", product.description);

    const metadata = document.createElement("div");
    metadata.className = "product-meta";
    addBadge(metadata, product.category_name);
    addBadge(metadata, money(product));
    if (product.included_with_premium) addBadge(metadata, "Premium included");
    card.appendChild(metadata);
    addText(card, "p", "By " + product.creator_name);

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
    if (product.price_minor === 0) {
      const download = document.createElement("button");
      download.type = "button";
      download.className = "button";
      download.textContent = "Download";
      download.addEventListener("click", function () {
        downloadProduct(product);
      });
      actions.appendChild(download);
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
    addText(elements.dialogContent, "p", "Creator: " + product.creator_name);
    addText(elements.dialogContent, "p", "Price: " + money(product));
    addText(elements.dialogContent, "p", "Licence: " + product.license);
    addText(elements.dialogContent, "p", "Formats: " + product.formats.join(", "));
    if (product.updated_at) {
      addText(elements.dialogContent, "p", "Last updated: " + new Date(product.updated_at).toLocaleDateString());
    }
    if (product.included_with_premium) addBadge(elements.dialogContent, "Included with BookWell Premium");
    const tags = document.createElement("p");
    tags.textContent = "Tags: " + product.tags.join(", ");
    elements.dialogContent.appendChild(tags);
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
      addText(elements.dialogContent, "p", "Online checkout is not enabled yet. Paid resources are not downloadable until secure payments are configured.");
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
        const response = await fetch(config.supabaseUrl.replace(/\/$/, "") + "/functions/v1/create-download", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: config.supabaseAnonKey,
            Authorization: "Bearer " + config.supabaseAnonKey
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

  async function loadCategories() {
    while (elements.category.options.length > 1) elements.category.remove(1);
    const url = config.supabaseUrl.replace(/\/$/, "") +
      "/rest/v1/categories?select=name,slug&is_active=eq.true&order=name.asc";
    const response = await fetch(url, {
      headers: { apikey: config.supabaseAnonKey, Authorization: "Bearer " + config.supabaseAnonKey }
    });
    if (!response.ok) throw new Error("Categories could not be loaded.");
    const categories = await response.json();
    categories.forEach(function (category) {
      const option = document.createElement("option");
      option.value = category.slug;
      option.textContent = category.name;
      elements.category.appendChild(option);
    });
  }

  async function loadProducts(append) {
    if (!configured()) {
      elements.results.hidden = true;
      elements.more.hidden = true;
      setStatus("The product catalog is not connected yet. Configure the public Supabase URL and anon key after applying the documented database setup. No sample or invented products are shown.", false);
      return;
    }
    if (append && loadingMore) return;
    const currentRequest = ++requestId;
    let parameters;
    try {
      parameters = core.buildSearchParameters({
        search: elements.search.value,
        category: elements.category.value,
        priceType: elements.price.value,
        fileFormat: elements.format.value,
        sort: elements.sort.value,
        minPrice: elements.minPrice.value,
        maxPrice: elements.maxPrice.value
      }, PAGE_SIZE, offset);
    } catch (error) {
      setStatus(error.message, true);
      elements.retry.hidden = true;
      return;
    }
    if (!append) {
      offset = 0;
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
        const message = parameters.p_price_type === "paid"
          ? "Paid products are unavailable until verified payment processing is implemented."
          : "No published resources match those filters. Try another search.";
        setStatus(message, false);
      } else {
        clearStatus();
      }
    } catch (error) {
      if (currentRequest !== requestId) return;
      setStatus(error.message || "The catalog could not be loaded. Please try again.", true);
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
  elements.form.addEventListener("input", function (event) {
    if (event.target === elements.search || event.target === elements.minPrice || event.target === elements.maxPrice) {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(function () { loadProducts(false); }, 300);
    }
  });
  elements.form.addEventListener("change", function (event) {
    if (event.target !== elements.search) loadProducts(false);
  });
  elements.more.addEventListener("click", function () { loadProducts(true); });
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
      setStatus(error.message || "The catalog setup could not be reached. Check the Supabase project configuration and database migration, then retry.", true);
    }
  }

  initializeCatalog();
  const initialProduct = location.hash.match(/^#product\/([a-z0-9-]+)$/);
  if (initialProduct) openProductSlug(initialProduct[1]);
})();
