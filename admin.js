(function () {
  "use strict";

  const config = window.BOOKWELL_CONFIG || {};
  const core = window.BookWellAdminCore;
  const elements = {
    signIn: document.getElementById("admin-signin"),
    email: document.getElementById("admin-email"),
    password: document.getElementById("admin-password"),
    signOut: document.getElementById("admin-signout"),
    status: document.getElementById("admin-status"),
    dashboard: document.getElementById("admin-dashboard"),
    account: document.getElementById("admin-account"),
    newProduct: document.getElementById("admin-new-product"),
    form: document.getElementById("admin-product-form"),
    formTitle: document.getElementById("admin-form-title"),
    products: document.getElementById("admin-products"),
    purchases: document.getElementById("admin-purchase-list"),
    language: document.getElementById("admin-product-language"),
    category: document.getElementById("admin-product-category"),
    title: document.getElementById("admin-product-title"),
    slug: document.getElementById("admin-product-slug"),
    file: document.getElementById("admin-product-file"),
    fileSummary: document.getElementById("admin-product-file-summary"),
    preview: document.getElementById("admin-product-preview"),
    previewSummary: document.getElementById("admin-product-preview-summary"),
    author: document.getElementById("admin-product-author"),
    subtitle: document.getElementById("admin-product-subtitle"),
    publicationYear: document.getElementById("admin-product-year"),
    edition: document.getElementById("admin-product-edition"),
    isbn: document.getElementById("admin-product-isbn"),
    pageCount: document.getElementById("admin-product-pages"),
    price: document.getElementById("admin-product-price"),
    productStatus: document.getElementById("admin-product-status"),
    allProductsFilter: document.querySelector('[data-studio-filter="all"]'),
    analytics: document.getElementById("studio-analytics"),
    purchases: document.getElementById("admin-purchases"),
    cancel: document.getElementById("admin-cancel-edit"),
    previewListing: document.getElementById("admin-preview-listing"),
    previewDialog: document.getElementById("admin-preview-dialog"),
    previewContent: document.getElementById("admin-preview-content"),
    previewClose: document.getElementById("admin-preview-close"),
    uploadProgress: document.getElementById("studio-upload-progress"),
    uploadStatus: document.getElementById("studio-upload-status"),
    totalProducts: document.getElementById("studio-total-products"),
    draftProducts: document.getElementById("studio-draft-products"),
    publishedProducts: document.getElementById("studio-published-products"),
    archivedProducts: document.getElementById("studio-archived-products"),
    downloadRequests: document.getElementById("studio-download-requests"),
    verifiedPurchases: document.getElementById("studio-verified-purchases"),
    analyticsNote: document.getElementById("studio-analytics-note")
  };
  let accessToken = null;
  let signedInUser = null;
  let studioRole = null;
  let productById = new Map();
  let allProducts = [];
  let studioFilter = "mine";
  let slugWasEdited = false;
  let previewObjectUrl = null;
  let formDirty = false;
  let saveInProgress = false;

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

  function apiUrl(path) {
    return config.supabaseUrl.replace(/\/$/, "") + path;
  }

  function setStatus(message, isError) {
    elements.status.textContent = message;
    elements.status.hidden = false;
    elements.status.setAttribute("role", isError ? "alert" : "status");
  }

  function clearStatus() {
    elements.status.hidden = true;
  }

  async function request(path, options) {
    const headers = new Headers(options?.headers || {});
    headers.set("apikey", config.supabaseAnonKey);
    if (accessToken) headers.set("Authorization", "Bearer " + accessToken);
    const response = await fetch(apiUrl(path), { ...options, headers: headers });
    if (!response.ok) {
      let message = "The administrator request failed.";
      try {
        const result = await response.json();
        message = result.msg || result.message || result.error_description || result.error || message;
      } catch {
        message = "The administrator request failed (HTTP " + response.status + ").";
      }
      throw new Error(message);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  function upload(bucket, path, file, contentType, onProgress) {
    const safePath = path.split("/").map(encodeURIComponent).join("/");
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", apiUrl("/storage/v1/object/" + bucket + "/" + safePath));
      xhr.setRequestHeader("apikey", config.supabaseAnonKey);
      xhr.setRequestHeader("Authorization", "Bearer " + accessToken);
      xhr.setRequestHeader("Content-Type", contentType);
      xhr.setRequestHeader("x-upsert", "false");
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable && typeof onProgress === "function") {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
          return;
        }
        let message = "Storage rejected the upload (HTTP " + xhr.status + ").";
        try {
          const body = JSON.parse(xhr.responseText);
          message = body.message || body.error || message;
        } catch {
          // Keep the status-based Storage error when the response is not JSON.
        }
        reject(new Error(message));
      });
      xhr.addEventListener("error", () => reject(new Error("The upload connection failed. Check your connection and retry.")));
      xhr.addEventListener("abort", () => reject(new Error("The upload was cancelled before Storage confirmed it.")));
      xhr.send(file);
    });
  }

  async function removeStorageObjects(bucket, paths) {
    const objects = paths.filter(Boolean).map((name) => ({ name: name }));
    if (objects.length === 0) return;
    await request("/storage/v1/object/" + bucket, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: objects.map((item) => item.name) })
    });
  }

  async function hasRole(requiredRole) {
    const result = await request("/rest/v1/rpc/has_role", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ required_role: requiredRole })
    });
    return result === true;
  }

  async function assertStudioAccess() {
    const adminAccess = await request("/rest/v1/rpc/has_role", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ required_role: "admin" })
    });
    if (adminAccess === true) {
      studioRole = "admin";
      return;
    }
    if (await hasRole("creator")) {
      studioRole = "creator";
      return;
    }
    throw new Error("This account is not authorized to manage BookWell listings.");
  }

  function applyStudioChrome() {
    const isAdmin = studioRole === "admin";
    if (elements.allProductsFilter) elements.allProductsFilter.hidden = !isAdmin;
    if (elements.analytics) elements.analytics.hidden = !isAdmin;
    if (elements.purchases) elements.purchases.hidden = !isAdmin;
    Array.from(elements.productStatus.options).forEach((option) => {
      option.hidden = !core.permittedStatuses(studioRole).includes(option.value);
    });
  }

  function setAuthenticated(user) {
    signedInUser = user;
    elements.signIn.hidden = true;
    elements.dashboard.hidden = false;
    elements.account.textContent = "Signed in as " + user.email;
  }

  function clearAuthenticated() {
    accessToken = null;
    signedInUser = null;
    studioRole = null;
    productById = new Map();
    elements.signIn.hidden = false;
    elements.dashboard.hidden = true;
    elements.products.replaceChildren();
    elements.form.reset();
    elements.form.hidden = true;
    elements.password.value = "";
  }

  function slugify(value) {
    return value.normalize("NFKD").toLowerCase().replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160);
  }

  function readForm(id) {
    const data = new FormData(elements.form);
    const fields = core.validateProductFields({
      title: data.get("title"),
      slug: data.get("slug"),
      description: data.get("description"),
      language: data.get("language"),
      license: data.get("license"),
      tags: String(data.get("tags") || ""),
      formats: data.getAll("formats").map(String),
      price: data.get("price"),
      currency: data.get("currency"),
      status: data.get("status")
    });
    if (!core.permittedStatuses(studioRole).includes(fields.status)) {
      throw new Error("This account cannot set that listing status.");
    }
    const book = core.validateBookFields({
      authorName: data.get("author_name"),
      subtitle: data.get("subtitle"),
      publicationYear: data.get("publication_year"),
      edition: data.get("edition"),
      isbn: data.get("isbn"),
      pageCount: data.get("page_count")
    });
    return {
      id: id,
      creator_id: studioRole === "admin"
        ? (productById.get(id)?.creator_id || signedInUser.id)
        : signedInUser.id,
      category_id: String(data.get("category_id")),
      title: fields.title,
      slug: fields.slug,
      description: fields.description,
      language: fields.language,
      tags: fields.tags,
      formats: fields.formats,
      license: fields.license,
      price_minor: fields.price_minor,
      currency: fields.currency,
      included_with_premium: false,
      status: fields.status,
      author_name: book.author_name,
      subtitle: book.subtitle,
      publication_year: book.publication_year,
      edition: book.edition,
      isbn: book.isbn,
      page_count: book.page_count
    };
  }

  function fillForm(product, duplicate) {
    elements.form.reset();
    const editing = Boolean(product && !duplicate);
    elements.form.elements.id.value = editing ? product.id : "";
    elements.title.value = product?.title
      ? (duplicate ? ("Copy of " + product.title).slice(0, 160) : product.title)
      : "";
    elements.slug.value = product?.slug
      ? (duplicate ? (slugify(product.slug + "-copy").slice(0, 160) || "new-product") : product.slug)
      : "";
    elements.form.elements.description.value = product?.description || "";
    elements.language.value = product?.language || "";
    elements.category.value = product?.category_id || "";
    elements.form.elements.license.value = product?.license || "";
    elements.form.elements.tags.value = (product?.tags || []).join(", ");
    elements.author.value = product?.author_name || "";
    elements.subtitle.value = product?.subtitle || "";
    elements.publicationYear.value = product?.publication_year || "";
    elements.edition.value = product?.edition || "";
    elements.isbn.value = product?.isbn || "";
    elements.pageCount.value = product?.page_count || "";
    elements.form.querySelectorAll('input[name="formats"]').forEach((input) => {
      input.checked = product ? (product.formats || []).includes(input.value) : input.value === "PDF";
    });
    const currency = product?.currency || "USD";
    elements.form.elements.currency.value = currency;
    setPriceStep();
    elements.price.value = window.BookWellMarketplaceCore.amountFromMinor(product?.price_minor || 0, currency)
      .toFixed(new Intl.NumberFormat(navigator.language, { style: "currency", currency: currency }).resolvedOptions().maximumFractionDigits);
    elements.productStatus.value = duplicate ? "draft" : (product?.status || "draft");
    elements.file.value = "";
    elements.preview.value = "";
    describeSelectedFile(elements.file, elements.fileSummary, core.productFileLimitBytes);
    describeSelectedFile(elements.preview, elements.previewSummary, core.previewFileLimitBytes);
    elements.uploadProgress.hidden = true;
    elements.uploadProgress.value = 0;
    const editable = core.canEditListing(studioRole, editing ? product : null);
    Array.from(elements.form.elements).forEach((field) => {
      if (field === elements.cancel || field === elements.previewListing || field.type === "hidden") {
        field.disabled = false;
        return;
      }
      field.disabled = !editable;
    });
    elements.uploadStatus.textContent = !editable
      ? "This listing is published or archived. Existing permissions allow only an administrator to change it."
      : (duplicate
        ? "Metadata copied into a new draft. Select a new private product file and cover image; storage files are not duplicated."
        : (existingFileNote(product, editing)));
    elements.formTitle.textContent = editing ? "Edit product: " + product.title : (duplicate ? "Duplicate product into draft" : "Create product draft");
    elements.form.hidden = false;
    slugWasEdited = editing || Boolean(duplicate);
    formDirty = false;
    elements.form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function existingFileNote(product, editing) {
    if (editing && product?.file_path) {
      return "Current private file is stored. Choose a new PDF or other supported file only if you intend to replace it.";
    }
    return "";
  }

  function describeSelectedFile(input, summary, maximumBytes) {
    if (!summary) return;
    const file = input.files[0];
    if (!file) {
      summary.textContent = "No file selected. Maximum size is " +
        Math.floor(maximumBytes / 1024 / 1024) + " MB.";
      return;
    }
    if (file.size <= 0) {
      summary.textContent = file.name + " · Empty file (0 bytes). Choose a valid file.";
      return;
    }
    if (file.size > maximumBytes) {
      summary.textContent = file.name + " · " + core.formatFileSize(file.size) + " exceeds limit (" + Math.floor(maximumBytes / 1024 / 1024) + " MB). Choose a smaller file.";
      return;
    }
    summary.textContent = file.name + " · " + core.formatFileSize(file.size) +
      " (limit " + Math.floor(maximumBytes / 1024 / 1024) + " MB)";
  }

  async function previewListing() {
    try {
      const id = elements.form.elements.id.value || crypto.randomUUID();
      const product = readForm(id);
      const category = Array.from(elements.category.options)
        .find((option) => option.value === product.category_id);
      if (!category) throw new Error("Choose a valid product category before previewing.");

      elements.previewContent.replaceChildren();
      const card = document.createElement("article");
      card.className = "card product-card";
      const heading = document.createElement("h2");
      heading.id = "admin-preview-title";
      heading.textContent = product.title;
      card.appendChild(heading);
      const selectedPreview = elements.preview.files[0];
      const existing = productById.get(id);
      const previewPath = selectedPreview ? null : existing?.preview_path;
      if (selectedPreview || previewPath) {
        const image = document.createElement("img");
        image.alt = "Preview for " + product.title;
        image.className = "product-preview product-preview-large";
        if (selectedPreview) {
          if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
          previewObjectUrl = URL.createObjectURL(selectedPreview);
          image.src = previewObjectUrl;
        } else {
          const encodedPath = previewPath.split("/").map(encodeURIComponent).join("/");
          const result = await request(
            "/storage/v1/object/sign/product-previews/" + encodedPath,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ expiresIn: 300 })
            }
          );
          image.src = window.BookWellMarketplaceCore.signedPreviewUrl(config.supabaseUrl, result.signedURL);
        }
        card.appendChild(image);
      } else {
        const cover = document.createElement("div");
        cover.className = "product-cover-fallback";
        cover.textContent = product.formats[0] || "Learning resource";
        cover.setAttribute("aria-hidden", "true");
        card.appendChild(cover);
      }
      const description = document.createElement("p");
      description.className = "product-description";
      description.textContent = product.description;
      card.appendChild(description);
      const metadata = document.createElement("div");
      metadata.className = "product-meta";
      [category.textContent, product.author_name || product.language,
        window.BookWellMarketplaceCore.formatPrice(product.price_minor, product.currency, navigator.language),
        product.status].forEach((value, index) => {
        const badge = document.createElement("span");
        badge.className = "product-badge" + (index === 2 ? " price-badge" : "");
        badge.textContent = value;
        metadata.appendChild(badge);
      });
      card.appendChild(metadata);
      elements.previewContent.appendChild(card);
      const details = [
        ["Subject", category.textContent],
        ["Author", product.author_name || "Not specified"],
        ["Subtitle", product.subtitle || "None"],
        ["Language", product.language],
        ["Format", product.formats.join(", ")],
        ["Licence", product.license],
        ["Publication year", product.publication_year || "Not specified"],
        ["Edition", product.edition || "Not specified"],
        ["ISBN", product.isbn || "Not specified"],
        ["Pages", product.page_count || "Not specified"],
        ["Tags", product.tags.join(", ") || "None"]
      ];
      details.forEach(([label, value]) => {
        const paragraph = document.createElement("p");
        paragraph.textContent = label + ": " + value;
        elements.previewContent.appendChild(paragraph);
      });
      const note = document.createElement("p");
      note.textContent = "Administrator preview only. This listing is not published by previewing it.";
      elements.previewContent.appendChild(note);
      elements.previewDialog.showModal();
    } catch (error) {
      setStatus(error.message || "The listing preview could not be created.", true);
    }
  }

  function renderProducts(products) {
    productById = new Map(products.map((product) => [product.id, product]));
    allProducts = products;
    const visibleProducts = window.BookWellAdminCore.filterProducts(products, studioFilter, signedInUser?.id);
    elements.products.replaceChildren();
    if (visibleProducts.length === 0) {
      const empty = document.createElement("p");
      empty.className = "studio-empty";
      empty.textContent = products.length === 0
        ? "No product listings yet. Create a draft to start a listing."
        : studioFilter === "mine" && products.length
          ? (studioRole === "admin"
            ? "You do not own any listings yet. Use All Products to view the full administration catalog."
            : "You do not have any listings yet. Create a PDF book draft to get started.")
        : "There are no " + (studioFilter === "all" ? "" : studioFilter + " ") + "products in this view.";
      elements.products.appendChild(empty);
      return;
    }
    visibleProducts.forEach((product) => {
      const card = document.createElement("article");
      card.className = "card studio-product-card";
      if (product.preview_path) {
        const cover = document.createElement("img");
        cover.alt = "";
        cover.className = "product-preview";
        cover.referrerPolicy = "no-referrer";
        card.appendChild(cover);
        showStudioCover(cover, product.preview_path);
      } else {
        const fallback = document.createElement("div");
        fallback.className = "product-cover-fallback";
        fallback.textContent = (product.formats || [])[0] || "Book";
        fallback.setAttribute("aria-hidden", "true");
        card.appendChild(fallback);
      }
      const heading = document.createElement("h3");
      heading.textContent = product.title;
      card.appendChild(heading);
      const status = document.createElement("p");
      status.textContent = "Status: " + product.status + " · " +
        window.BookWellMarketplaceCore.formatPrice(product.price_minor, product.currency, navigator.language);
      card.appendChild(status);
      const categoryName = categoryLabel(product.category_id);
      if (categoryName) {
        const category = document.createElement("p");
        category.textContent = "Category: " + categoryName;
        card.appendChild(category);
      }
      if (product.author_name) {
        const author = document.createElement("p");
        author.textContent = "Author: " + product.author_name;
        card.appendChild(author);
      }
      if (product.language) {
        const language = document.createElement("p");
        language.textContent = "Language: " + product.language;
        card.appendChild(language);
      }
      const formats = document.createElement("p");
      formats.textContent = "Format: " + product.formats.join(", ");
      card.appendChild(formats);
      const updated = document.createElement("p");
      updated.className = "studio-note";
      updated.textContent = "Updated " + new Date(product.updated_at).toLocaleDateString();
      card.appendChild(updated);
      const actions = document.createElement("div");
      actions.className = "product-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "button secondary";
      edit.textContent = core.canEditListing(studioRole, product) ? "Edit" : "View";
      edit.addEventListener("click", () => fillForm(product));
      actions.appendChild(edit);
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "button secondary";
      preview.textContent = "Preview";
      preview.addEventListener("click", () => {
        fillForm(product);
        previewListing();
      });
      actions.appendChild(preview);
      const duplicate = document.createElement("button");
      duplicate.type = "button";
      duplicate.className = "button secondary";
      duplicate.textContent = "Duplicate";
      duplicate.addEventListener("click", () => fillForm(product, true));
      actions.appendChild(duplicate);
      if (studioRole === "admin") {
        const publication = document.createElement("button");
        publication.type = "button";
        publication.className = "button secondary";
        publication.textContent = product.status === "published" ? "Archive listing" : "Publish listing";
        publication.addEventListener("click", () => updateProductStatus(
          product,
          product.status === "published" ? "archived" : "published"
        ));
        actions.appendChild(publication);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "button secondary";
        remove.textContent = "Delete";
        remove.addEventListener("click", () => deleteProduct(product));
        actions.appendChild(remove);
      }
      card.appendChild(actions);
      elements.products.appendChild(card);
    });
  }

  function categoryLabel(categoryId) {
    const option = Array.from(elements.category.options).find((item) => item.value === categoryId);
    return option ? option.textContent : "";
  }

  async function showStudioCover(image, previewPath) {
    try {
      const encodedPath = previewPath.split("/").map(encodeURIComponent).join("/");
      const result = await request(
        "/storage/v1/object/sign/product-previews/" + encodedPath,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expiresIn: 300 })
        }
      );
      image.src = window.BookWellMarketplaceCore.signedPreviewUrl(config.supabaseUrl, result.signedURL);
      image.addEventListener("error", () => {
        const fallback = document.createElement("div");
        fallback.className = "product-cover-fallback";
        fallback.textContent = "Cover unavailable";
        image.replaceWith(fallback);
      }, { once: true });
    } catch {
      const fallback = document.createElement("div");
      fallback.className = "product-cover-fallback";
      fallback.textContent = "Cover unavailable";
      if (image.parentNode) image.replaceWith(fallback);
    }
  }

  async function countRows(path) {
    const headers = new Headers({
      apikey: config.supabaseAnonKey,
      Authorization: "Bearer " + accessToken,
      Prefer: "count=exact",
      Range: "0-0"
    });
    const response = await fetch(apiUrl("/rest/v1/" + path), { method: "HEAD", headers: headers });
    if (!response.ok) throw new Error("The analytics count could not be loaded.");
    const contentRange = response.headers.get("content-range") || "";
    const match = contentRange.match(/\/(\d+)$/);
    if (!match) throw new Error("The analytics count was not provided by Supabase.");
    return Number(match[1]);
  }

  function renderStudioMetrics(products, counts) {
    elements.totalProducts.textContent = window.BookWellAdminCore.metricValue(counts.total);
    elements.draftProducts.textContent = window.BookWellAdminCore.metricValue(counts.draft);
    elements.publishedProducts.textContent = window.BookWellAdminCore.metricValue(counts.published);
    elements.archivedProducts.textContent = window.BookWellAdminCore.metricValue(counts.archived);
    elements.downloadRequests.textContent = window.BookWellAdminCore.metricValue(counts.downloadRequests);
    elements.verifiedPurchases.textContent = window.BookWellAdminCore.metricValue(counts.verifiedPurchases);
    const notices = [
      "Link issuance is not a confirmed download.",
      "Page views and revenue are not tracked."
    ];
    if ([counts.total, counts.draft, counts.published, counts.archived].some((count) => count === null)) {
      notices.push("Some product summary counts are unavailable.");
    }
    if (counts.downloadRequests === null) notices.push("Download-link event totals are unavailable.");
    if (counts.verifiedPurchases === null) notices.push("Verified purchase counts are unavailable until commerce schema and records are configured.");
    if (products.length === 500) notices.push("Product management is showing the latest 500 listings.");
    elements.analyticsNote.textContent = notices.join(" ");
  }

  async function updateProductStatus(product, status) {
    if (!window.confirm(status === "published"
      ? "Publish “" + product.title + "”? Public metadata will become visible. Private downloads will still require authorization."
      : "Archive “" + product.title + "”? It will be removed from public listings.")) return;
    try {
      await request("/rest/v1/products?id=eq." + encodeURIComponent(product.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ status: status })
      });
      await loadAdminData();
      setStatus(status === "published" ? "Product listing published." : "Product listing archived and unpublished.", false);
    } catch (error) {
      setStatus(error.message || "The product status could not be updated.", true);
    }
  }

  function renderPurchases(orders) {
    elements.purchases.replaceChildren();
    if (!orders.length) {
      const empty = document.createElement("p");
      empty.className = "purchase-empty";
      empty.textContent = "No purchase records are available.";
      elements.purchases.appendChild(empty);
      return;
    }
    orders.forEach((order) => {
      const row = document.createElement("article");
      row.className = "purchase-row";
      const item = order.order_items?.[0];
      const title = document.createElement("strong");
      title.textContent = item?.products?.title || "BookWell product";
      row.appendChild(title);
      const amount = document.createElement("span");
      amount.textContent = window.BookWellMarketplaceCore.formatPrice(order.total_minor, order.currency, navigator.language);
      row.appendChild(amount);
      const status = document.createElement("span");
      status.textContent = order.status + (order.verified_at ? " · verified" : "");
      row.appendChild(status);
      const created = document.createElement("span");
      created.textContent = new Date(order.created_at).toLocaleString();
      row.appendChild(created);
      const reference = document.createElement("span");
      reference.textContent = "Order " + order.id + (order.provider_checkout_id
        ? " · Provider ref " + order.provider_checkout_id : "");
      row.appendChild(reference);
      const customer = document.createElement("span");
      customer.textContent = "Customer " + order.user_id;
      row.appendChild(customer);
      elements.purchases.appendChild(row);
    });
  }

  async function loadAdminData() {
    setStatus("Checking listing access and loading products…", false);
    await assertStudioAccess();
    applyStudioChrome();
    if (studioRole !== "admin" && studioFilter === "all") {
      studioFilter = "mine";
      document.querySelectorAll("[data-studio-filter]").forEach((tab) => {
        tab.setAttribute("aria-pressed", String(tab.dataset.studioFilter === "mine"));
      });
    }
    const categoryQuery = studioRole === "admin"
      ? "/rest/v1/categories?select=id,name,slug,is_active&order=name.asc"
      : "/rest/v1/categories?select=id,name,slug,is_active&is_active=eq.true&order=name.asc";
    const [categories, products, orders, counts] = await Promise.all([
      request(categoryQuery, { method: "GET" }),
      request("/rest/v1/rpc/admin_list_products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      }),
      studioRole === "admin"
        ? request("/rest/v1/orders?select=id,user_id,status,total_minor,currency,provider,provider_checkout_id,created_at,verified_at,order_items(products(title,slug))&order=created_at.desc&limit=100", { method: "GET" })
        : Promise.resolve([]),
      studioRole === "admin"
        ? Promise.all([
          countRows("products?select=id").catch(() => null),
          countRows("products?select=id&status=eq.draft").catch(() => null),
          countRows("products?select=id&status=eq.published").catch(() => null),
          countRows("products?select=id&status=eq.archived").catch(() => null),
          countRows("download_events?select=id&created_at=gte." + encodeURIComponent(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())).catch(() => null),
          countRows("orders?select=id&status=eq.paid&verified_at=not.is.null").catch(() => null)
        ]).then(([total, draft, published, archived, downloadRequests, verifiedPurchases]) => ({
          total, draft, published, archived, downloadRequests, verifiedPurchases
        }))
        : Promise.resolve({
          total: null,
          draft: null,
          published: null,
          archived: null,
          downloadRequests: null,
          verifiedPurchases: null
        })
    ]);
    const listingCounts = studioRole === "admin" ? counts : {
      total: products.length,
      draft: products.filter((product) => product.status === "draft").length,
      published: products.filter((product) => product.status === "published").length,
      archived: products.filter((product) => product.status === "archived").length,
      downloadRequests: null,
      verifiedPurchases: null
    };
    elements.category.replaceChildren();
    categories.forEach((category) => {
      const option = document.createElement("option");
      option.value = category.id;
      option.textContent = category.name + (category.is_active ? "" : " (inactive)");
      elements.category.appendChild(option);
    });
    renderProducts(products);
    if (studioRole === "admin") renderPurchases(orders);
    renderStudioMetrics(products, listingCounts);
    clearStatus();
  }

  async function handleSignIn(event) {
    event.preventDefault();
    if (!configured()) {
      setStatus("Supabase is not configured. Add the public project URL and anon key before signing in.", true);
      return;
    }
    setStatus("Signing in and verifying listing permissions…", false);
    try {
      const response = await fetch(apiUrl("/auth/v1/token?grant_type=password"), {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: config.supabaseAnonKey },
        body: JSON.stringify({ email: elements.email.value.trim(), password: elements.password.value })
      });
      const result = await response.json();
      if (!response.ok || !result.access_token || !result.user?.id) {
        throw new Error("Sign in failed. Check your credentials and Supabase Auth configuration.");
      }
      accessToken = result.access_token;
      await assertStudioAccess();
      setAuthenticated(result.user);
      await loadAdminData();
    } catch (error) {
      accessToken = null;
      clearAuthenticated();
      setStatus(error.message || "Creator Studio sign in failed.", true);
    }
  }

  async function signOut() {
    if (formDirty && !window.confirm("Sign out and discard unsaved edits? The last saved listings will remain unchanged.")) return;
    const token = accessToken;
    clearAuthenticated();
    clearStatus();
    if (token && configured()) {
      try {
        const response = await fetch(apiUrl("/auth/v1/logout"), {
          method: "POST",
          headers: { apikey: config.supabaseAnonKey, Authorization: "Bearer " + token }
        });
        if (!response.ok) {
          setStatus("Signed out locally, but the server could not invalidate the access token.", true);
        }
      } catch {
        setStatus("Signed out locally. The server session could not be invalidated; the access token remains short-lived.", true);
      }
    }
  }

  async function saveProduct(event) {
    event.preventDefault();
    if (saveInProgress) return;
    const submit = elements.form.querySelector('button[type="submit"]');
    saveInProgress = true;
    submit.disabled = true;
    const uploadedProductPaths = [];
    const uploadedPreviewPaths = [];
    let metadataSaved = false;
    try {
      elements.uploadProgress.hidden = true;
      elements.uploadProgress.value = 0;
      elements.uploadStatus.textContent = "";
      const id = elements.form.elements.id.value || crypto.randomUUID();
      if (!isUuid(id)) throw new Error("The product ID is invalid.");
      const product = readForm(id);
      const existing = productById.get(id);
      if (!core.canEditListing(studioRole, existing)) {
        throw new Error("Existing permissions do not allow this account to change that listing.");
      }
      if (product.status === "published" && existing?.status !== "published" &&
          !window.confirm("Publish this listing? Its public metadata will become visible. Private download access will still be checked separately.")) return;
      const categoryExists = Array.from(elements.category.options).some((option) => option.value === product.category_id);
      if (!categoryExists) throw new Error("Choose a valid product category.");

      const productFile = elements.file.files[0];
      let productPath = existing?.file_path || "";
      if (productFile) {
        const validated = await core.validateFile(productFile, core.productTypes, 50 * 1024 * 1024, "Product file");
        if (!product.formats.includes(validated.extension.toUpperCase())) {
          throw new Error("The product file format must be selected in Supported file formats.");
        }
        productPath = id + "/" + crypto.randomUUID() + "." + validated.extension;
        elements.uploadProgress.hidden = false;
        elements.uploadStatus.textContent = "Uploading private product file…";
        await upload("product-files", productPath, productFile, validated.mime, (percent) => {
          elements.uploadProgress.value = percent;
          elements.uploadStatus.textContent = "Uploading private product file — " + percent + "%.";
        });
        elements.uploadProgress.value = 100;
        elements.uploadStatus.textContent = "Product file confirmed by Storage.";
        uploadedProductPaths.push(productPath);
      }
      if (!productPath) throw new Error("Choose a product file before saving a new listing.");
      product.file_path = productPath;

      const previewFile = elements.preview.files[0];
      let previewPath = existing?.preview_path || null;
      if (previewFile) {
        const validated = await core.validateFile(previewFile, core.previewTypes, 2 * 1024 * 1024, "Preview image");
        previewPath = id + "/" + crypto.randomUUID() + "." + validated.extension;
        elements.uploadProgress.hidden = false;
        elements.uploadProgress.value = 0;
        elements.uploadStatus.textContent = "Uploading private cover image…";
        await upload("product-previews", previewPath, previewFile, validated.mime, (percent) => {
          elements.uploadProgress.value = percent;
          elements.uploadStatus.textContent = "Uploading private cover image — " + percent + "%.";
        });
        elements.uploadProgress.value = 100;
        elements.uploadStatus.textContent = "Cover image confirmed by Storage.";
        uploadedPreviewPaths.push(previewPath);
      }
      product.preview_path = previewPath;

      setStatus("Saving product metadata…", false);
      await request("/rest/v1/products" + (existing ? "?id=eq." + encodeURIComponent(id) : ""), {
        method: existing ? "PATCH" : "POST",
        headers: {
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify(product)
      });
      metadataSaved = true;

      const oldProductPath = existing && existing.file_path !== productPath ? existing.file_path : null;
      const oldPreviewPath = existing && existing.preview_path !== previewPath ? existing.preview_path : null;
      let orphanedObjects = false;
      try {
        await Promise.all([
          removeStorageObjects("product-files", [oldProductPath]),
          removeStorageObjects("product-previews", [oldPreviewPath])
        ]);
      } catch {
        orphanedObjects = true;
      }
      elements.form.reset();
      elements.form.hidden = true;
      formDirty = false;
      await loadAdminData();
      if (!elements.status.hidden) {
        setStatus("Product was saved, but the admin list could not be refreshed. Retry the product list.", true);
        return;
      }
      if (orphanedObjects) {
        setStatus("Listing saved, but an old private file or preview could not be removed. Review storage for an orphaned object.", true);
      } else {
        setStatus("Product listing saved.", false);
      }
    } catch (error) {
      const cleanupResults = [];
      if (!metadataSaved) {
        cleanupResults.push(...await Promise.allSettled([
          removeStorageObjects("product-files", uploadedProductPaths),
          removeStorageObjects("product-previews", uploadedPreviewPaths)
        ]));
      }
      if (metadataSaved) {
        setStatus("Product was saved, but the Studio could not refresh the product list. Refresh the page to verify the saved listing.", true);
      } else if (cleanupResults.some((result) => result.status === "rejected")) {
        setStatus((error.message || "The product listing could not be saved.") +
          " A temporary private upload may remain in Storage and needs administrator cleanup.", true);
      } else {
        setStatus(error.message || "The product listing could not be saved.", true);
      }
      if (elements.uploadStatus.textContent.startsWith("Uploading")) {
        elements.uploadStatus.textContent = "Upload failed. Select Save listing to retry; the selected local file remains available.";
      }
    } finally {
      saveInProgress = false;
      submit.disabled = false;
    }
  }

  async function deleteProduct(product) {
    if (!window.confirm("Permanently delete “" + product.title + "”? This cannot be undone. Products with orders cannot be deleted; archive them instead.")) return;
    try {
      const orderItems = await request("/rest/v1/order_items?select=id&product_id=eq." +
        encodeURIComponent(product.id) + "&limit=1", { method: "GET" });
      if (orderItems.length > 0) {
        throw new Error("This product has order history and cannot be deleted. Change its status to Archived instead.");
      }
      await request("/rest/v1/products?id=eq." + encodeURIComponent(product.id), { method: "DELETE" });
      try {
        await Promise.all([
          removeStorageObjects("product-files", [product.file_path]),
          removeStorageObjects("product-previews", [product.preview_path])
        ]);
      } catch {
        await loadAdminData();
        setStatus("Listing deleted, but a storage object could not be removed. Review storage for an orphaned object.", true);
        return;
      }
      await loadAdminData();
      setStatus("Product listing deleted.", false);
    } catch (error) {
      setStatus(error.message || "The product listing could not be deleted.", true);
    }
  }

  elements.signIn.addEventListener("submit", handleSignIn);
  elements.signOut.addEventListener("click", signOut);
  elements.newProduct.addEventListener("click", () => fillForm(null));
  elements.form.addEventListener("submit", saveProduct);
  elements.form.addEventListener("input", () => { if (!elements.form.hidden) formDirty = true; });
  elements.form.addEventListener("change", () => { if (!elements.form.hidden) formDirty = true; });
  document.querySelectorAll("[data-studio-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      studioFilter = button.dataset.studioFilter;
      document.querySelectorAll("[data-studio-filter]").forEach((tab) => {
        tab.setAttribute("aria-pressed", String(tab === button));
      });
      renderProducts(allProducts);
    });
  });
  elements.previewListing.addEventListener("click", previewListing);
  elements.previewClose.addEventListener("click", () => elements.previewDialog.close());
  elements.previewDialog.addEventListener("close", () => {
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  });
  elements.cancel.addEventListener("click", () => {
    if (formDirty && !window.confirm("Discard unsaved changes? The last saved listing will remain unchanged.")) return;
    elements.form.hidden = true;
    formDirty = false;
  });
  elements.title.addEventListener("input", () => {
    if (!slugWasEdited) elements.slug.value = slugify(elements.title.value);
  });
  elements.slug.addEventListener("input", () => { slugWasEdited = true; });
  function setPriceStep() {
    const digits = new Intl.NumberFormat(navigator.language, {
      style: "currency",
      currency: elements.form.elements.currency.value
    }).resolvedOptions().maximumFractionDigits;
    elements.price.step = digits ? "0." + "0".repeat(Math.max(digits - 1, 0)) + "1" : "1";
  }
  elements.form.elements.currency.addEventListener("change", setPriceStep);
  elements.file.addEventListener("change", () => {
    describeSelectedFile(elements.file, elements.fileSummary, core.productFileLimitBytes);
    const selected = elements.file.files[0];
    if (selected && /\.pdf$/i.test(selected.name)) {
      const pdf = elements.form.querySelector('input[name="formats"][value="PDF"]');
      if (pdf) pdf.checked = true;
    }
  });
  elements.preview.addEventListener("change", () => {
    describeSelectedFile(elements.preview, elements.previewSummary, core.previewFileLimitBytes);
  });

  if (!configured()) {
    elements.signIn.hidden = true;
    setStatus("Supabase is not configured. Creator Studio is disabled until a project URL, public anon key, migration and Auth are configured.", false);
  } else {
    setStatus("Sign in with an administrator or authorized creator account. Public sign-up does not grant listing permissions.", false);
  }
})();
