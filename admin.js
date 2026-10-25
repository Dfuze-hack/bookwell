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
    category: document.getElementById("admin-product-category"),
    title: document.getElementById("admin-product-title"),
    slug: document.getElementById("admin-product-slug"),
    file: document.getElementById("admin-product-file"),
    preview: document.getElementById("admin-product-preview"),
    price: document.getElementById("admin-product-price"),
    productStatus: document.getElementById("admin-product-status"),
    cancel: document.getElementById("admin-cancel-edit"),
    previewListing: document.getElementById("admin-preview-listing"),
    previewDialog: document.getElementById("admin-preview-dialog"),
    previewContent: document.getElementById("admin-preview-content"),
    previewClose: document.getElementById("admin-preview-close")
  };
  let accessToken = null;
  let signedInUser = null;
  let productById = new Map();
  let slugWasEdited = false;
  let previewObjectUrl = null;

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

  async function upload(bucket, path, file, contentType) {
    const safePath = path.split("/").map(encodeURIComponent).join("/");
    return request("/storage/v1/object/" + bucket + "/" + safePath, {
      method: "POST",
      headers: { "Content-Type": contentType, "x-upsert": "false" },
      body: file
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

  async function assertAdministrator() {
    const result = await request("/rest/v1/rpc/has_role", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ required_role: "admin" })
    });
    if (result !== true) throw new Error("This account is not authorized to administer BookWell.");
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
      license: data.get("license"),
      tags: String(data.get("tags") || ""),
      formats: data.getAll("formats").map(String),
      price: data.get("price"),
      status: data.get("status")
    });
    return {
      id: id,
      creator_id: signedInUser.id,
      category_id: String(data.get("category_id")),
      title: fields.title,
      slug: fields.slug,
      description: fields.description,
      tags: fields.tags,
      formats: fields.formats,
      license: fields.license,
      price_minor: fields.price_minor,
      currency: "INR",
      included_with_premium: false,
      status: fields.status
    };
  }

  function fillForm(product) {
    elements.form.reset();
    elements.form.elements.id.value = product?.id || "";
    elements.title.value = product?.title || "";
    elements.slug.value = product?.slug || "";
    elements.form.elements.description.value = product?.description || "";
    elements.category.value = product?.category_id || "";
    elements.form.elements.license.value = product?.license || "";
    elements.form.elements.tags.value = (product?.tags || []).join(", ");
    elements.form.querySelectorAll('input[name="formats"]').forEach((input) => {
      input.checked = (product?.formats || []).includes(input.value);
    });
    elements.price.value = ((product?.price_minor || 0) / 100).toFixed(2);
    elements.productStatus.value = product?.status || "draft";
    elements.file.value = "";
    elements.preview.value = "";
    elements.formTitle.textContent = product ? "Edit product: " + product.title : "Create product";
    elements.form.hidden = false;
    slugWasEdited = Boolean(product);
    elements.form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function previewListing() {
    try {
      const id = elements.form.elements.id.value || crypto.randomUUID();
      const product = readForm(id);
      const category = Array.from(elements.category.options)
        .find((option) => option.value === product.category_id);
      if (!category) throw new Error("Choose a valid product category before previewing.");

      elements.previewContent.replaceChildren();
      const heading = document.createElement("h2");
      heading.id = "admin-preview-title";
      heading.textContent = product.title;
      elements.previewContent.appendChild(heading);
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
        elements.previewContent.appendChild(image);
      }
      const details = [
        ["Category", category.textContent],
        ["Price", product.price_minor === 0 ? "Free" : "INR " + (product.price_minor / 100).toFixed(2)],
        ["Status", product.status],
        ["Formats", product.formats.join(", ")],
        ["Licence", product.license],
        ["Description", product.description],
        ["Tags", product.tags.join(", ")]
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
    elements.products.replaceChildren();
    if (products.length === 0) {
      const empty = document.createElement("p");
      empty.className = "catalog-status";
      empty.textContent = "No product listings yet.";
      elements.products.appendChild(empty);
      return;
    }
    products.forEach((product) => {
      const card = document.createElement("article");
      card.className = "card product-card";
      const heading = document.createElement("h3");
      heading.textContent = product.title;
      card.appendChild(heading);
      const status = document.createElement("p");
      status.textContent = "Status: " + product.status + " · " +
        (product.price_minor === 0 ? "Free" : "INR " + (product.price_minor / 100).toFixed(2));
      card.appendChild(status);
      const actions = document.createElement("div");
      actions.className = "product-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "button secondary";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => fillForm(product));
      actions.appendChild(edit);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button secondary";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => deleteProduct(product));
      actions.appendChild(remove);
      card.appendChild(actions);
      elements.products.appendChild(card);
    });
  }

  async function loadAdminData() {
    setStatus("Checking administrator access and loading products…", false);
    await assertAdministrator();
    const [categories, products] = await Promise.all([
      request("/rest/v1/categories?select=id,name,slug,is_active&order=name.asc", { method: "GET" }),
      request("/rest/v1/products?select=id,creator_id,category_id,title,slug,description,tags,formats,license,preview_path,file_path,price_minor,currency,included_with_premium,status,updated_at&order=updated_at.desc&limit=100", { method: "GET" })
    ]);
    elements.category.replaceChildren();
    categories.forEach((category) => {
      const option = document.createElement("option");
      option.value = category.id;
      option.textContent = category.name + (category.is_active ? "" : " (inactive)");
      elements.category.appendChild(option);
    });
    renderProducts(products);
    clearStatus();
  }

  async function handleSignIn(event) {
    event.preventDefault();
    if (!configured()) {
      setStatus("Supabase is not configured. Add the public project URL and anon key before signing in.", true);
      return;
    }
    setStatus("Signing in and verifying administrator role…", false);
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
      await assertAdministrator();
      setAuthenticated(result.user);
      await loadAdminData();
    } catch (error) {
      accessToken = null;
      clearAuthenticated();
      setStatus(error.message || "Administrator sign in failed.", true);
    }
  }

  async function signOut() {
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
    const uploadedProductPaths = [];
    const uploadedPreviewPaths = [];
    let metadataSaved = false;
    try {
      const id = elements.form.elements.id.value || crypto.randomUUID();
      if (!isUuid(id)) throw new Error("The product ID is invalid.");
      const product = readForm(id);
      const existing = productById.get(id);
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
        await upload("product-files", productPath, productFile, validated.mime);
        uploadedProductPaths.push(productPath);
      }
      if (!productPath) throw new Error("Choose a product file before saving a new listing.");
      product.file_path = productPath;

      const previewFile = elements.preview.files[0];
      let previewPath = existing?.preview_path || null;
      if (previewFile) {
        const validated = await core.validateFile(previewFile, core.previewTypes, 2 * 1024 * 1024, "Preview image");
        previewPath = id + "/" + crypto.randomUUID() + "." + validated.extension;
        await upload("product-previews", previewPath, previewFile, validated.mime);
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
      if (!metadataSaved) {
        await Promise.all([
          removeStorageObjects("product-files", uploadedProductPaths).catch(() => null),
          removeStorageObjects("product-previews", uploadedPreviewPaths).catch(() => null)
        ]);
      }
      setStatus(error.message || "The product listing could not be saved.", true);
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
  elements.previewListing.addEventListener("click", previewListing);
  elements.previewClose.addEventListener("click", () => elements.previewDialog.close());
  elements.previewDialog.addEventListener("close", () => {
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  });
  elements.cancel.addEventListener("click", () => { elements.form.hidden = true; });
  elements.title.addEventListener("input", () => {
    if (!slugWasEdited) elements.slug.value = slugify(elements.title.value);
  });
  elements.slug.addEventListener("input", () => { slugWasEdited = true; });

  if (!configured()) {
    elements.signIn.hidden = true;
    setStatus("Supabase is not configured. Administrator tools are disabled until a project URL, public anon key, migration and Auth are configured.", false);
  } else {
    setStatus("Sign in with an administrator account. Public sign-up is disabled.", false);
  }
})();
