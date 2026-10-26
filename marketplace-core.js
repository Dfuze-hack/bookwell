(function (root) {
  "use strict";

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function currencyDigits(currency, locale) {
    if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
      throw new Error("Choose a valid ISO currency code.");
    }
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency })
      .resolvedOptions().maximumFractionDigits;
  }

  function priceMinor(value, currency) {
    if (value === "" || value === null || value === undefined) return null;
    const text = String(value);
    const amount = Number(text);
    const digits = currencyDigits(currency);
    const decimalPattern = digits ? "(?:\\.\\d{1," + digits + "})?" : "";
    if (!(new RegExp("^\\d+" + decimalPattern + "$")).test(text) ||
        !Number.isFinite(amount) || amount < 0 ||
        amount > Math.min(20000000, 2147483647 / Math.pow(10, digits))) {
      throw new Error("Enter a price between 0 and 20,000,000.");
    }
    return Math.round(amount * Math.pow(10, digits));
  }

  function buildSearchParameters(filters, pageSize, offset) {
    const sortOptions = ["newest", "relevance", "title", "price_asc", "price_desc"];
    if (!sortOptions.includes(filters.sort)) {
      throw new Error("Choose a valid sort order.");
    }
    const hasPriceRange = filters.minPrice !== "" || filters.maxPrice !== "";
    if (hasPriceRange && !filters.currency) {
      throw new Error("Choose a currency before setting a minimum or maximum price.");
    }
    const selectedCurrency = filters.currency || null;
    const minPriceMinor = priceMinor(filters.minPrice, selectedCurrency);
    const maxPriceMinor = priceMinor(filters.maxPrice, selectedCurrency);
    if (minPriceMinor !== null && maxPriceMinor !== null && minPriceMinor > maxPriceMinor) {
      throw new Error("Minimum price cannot be greater than maximum price.");
    }
    return {
      p_search: filters.search.trim() || null,
      p_category: filters.category || null,
      p_language: filters.language || null,
      p_price_type: filters.priceType || null,
      p_file_format: filters.fileFormat || null,
      p_sort: filters.sort,
      p_limit: pageSize + 1,
      p_offset: Math.max(offset, 0),
      p_min_price_minor: minPriceMinor,
      p_max_price_minor: maxPriceMinor,
      p_currency: minPriceMinor !== null || maxPriceMinor !== null ? selectedCurrency : null
    };
  }

  function validateCatalogueRows(rows) {
    if (!Array.isArray(rows)) throw new Error("The product catalog returned an invalid response.");
    rows.forEach(function (product) {
      if (!product || !UUID_PATTERN.test(product.id) ||
          typeof product.title !== "string" || typeof product.slug !== "string" ||
          !Array.isArray(product.tags) || !Array.isArray(product.formats) ||
          product.tags.some(function (tag) { return typeof tag !== "string"; }) ||
          product.formats.some(function (format) { return typeof format !== "string"; }) ||
          !Number.isSafeInteger(product.price_minor) || product.price_minor < 0 ||
          typeof product.currency !== "string" || !/^[A-Z]{3}$/.test(product.currency) ||
          (product.language !== undefined && product.language !== null && typeof product.language !== "string") ||
          (product.created_at !== undefined && !Number.isFinite(Date.parse(product.created_at)))) {
        throw new Error("The product catalog returned an invalid product.");
      }
    });
    return rows;
  }

  function rankRecommendations(products, preferences, limit) {
    const settings = preferences || {};
    const selectedCategories = new Set((settings.categories || []).map(function (value) {
      return String(value).trim().toLocaleLowerCase();
    }).filter(Boolean));
    const searchTerms = String(settings.search || "").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    const recentlyViewed = new Set((settings.recentlyViewed || []).map(String));
    const ranked = products.map(function (product, index) {
      let score = 0;
      if (selectedCategories.has(String(product.category_name || "").trim().toLocaleLowerCase())) score += 100;
      const title = String(product.title || "").toLocaleLowerCase();
      const description = String(product.description || "").toLocaleLowerCase();
      const category = String(product.category_name || "").toLocaleLowerCase();
      const tags = (product.tags || []).join(" ").toLocaleLowerCase();
      searchTerms.forEach(function (term) {
        if (title.includes(term)) score += 12;
        if (tags.includes(term)) score += 8;
        if (category.includes(term)) score += 6;
        if (description.includes(term)) score += 2;
      });
      if (recentlyViewed.has(product.slug)) score -= 1000;
      const timestamp = Date.parse(product.created_at || product.updated_at || "");
      return { product: product, score: score, timestamp: Number.isFinite(timestamp) ? timestamp : 0, index: index };
    });
    ranked.sort(function (a, b) {
      return b.score - a.score || b.timestamp - a.timestamp ||
        String(a.product.title || "").localeCompare(String(b.product.title || "")) || a.index - b.index;
    });
    return ranked.slice(0, Math.max(0, limit)).map(function (item) { return item.product; });
  }

  function timestamp(product) {
    const value = Date.parse(product.created_at || product.updated_at || "");
    return Number.isFinite(value) ? value : 0;
  }

  function relatedProducts(products, currentProduct, limit) {
    return products.map(function (product, index) {
      if (product.id === currentProduct.id) return null;
      let score = 0;
      if (product.category_name && product.category_name === currentProduct.category_name) score += 10;
      if (product.language && currentProduct.language &&
          product.language.toLocaleLowerCase() === currentProduct.language.toLocaleLowerCase()) score += 4;
      const formats = new Set(currentProduct.formats || []);
      score += (product.formats || []).filter(function (format) { return formats.has(format); }).length * 2;
      const tags = new Set((currentProduct.tags || []).map(function (tag) { return String(tag).toLocaleLowerCase(); }));
      score += (product.tags || []).filter(function (tag) { return tags.has(String(tag).toLocaleLowerCase()); }).length;
      return { product: product, score: score, index: index };
    }).filter(function (item) {
      return item && item.score > 0;
    }).sort(function (a, b) {
      return b.score - a.score || timestamp(b.product) - timestamp(a.product) || a.index - b.index;
    }).slice(0, Math.max(0, limit)).map(function (item) { return item.product; });
  }

  function formatPrice(priceMinorValue, currency, locale) {
    if (!Number.isSafeInteger(priceMinorValue) || priceMinorValue < 0 ||
        typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
      throw new Error("The product price or currency is invalid.");
    }
    if (priceMinorValue === 0) return "Free";
    try {
      const digits = currencyDigits(currency, locale);
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: currency,
        currencyDisplay: "symbol"
      }).format(priceMinorValue / Math.pow(10, digits));
    } catch {
      return currency + " " + priceMinorValue + " minor units";
    }
  }

  function amountFromMinor(priceMinorValue, currency) {
    return priceMinorValue / Math.pow(10, currencyDigits(currency));
  }

  function signedPreviewUrl(baseUrl, signedPath) {
    const base = new URL(baseUrl);
    const result = new URL(signedPath, base);
    if (result.origin !== base.origin ||
        !result.pathname.startsWith("/storage/v1/object/sign/product-previews/")) {
      throw new Error("The preview service returned an invalid URL.");
    }
    return result.href;
  }

  function shouldRefreshDownload(response) {
    return Boolean(response) && [400, 401, 403].includes(response.status);
  }

  function productAccessDecision(product, access) {
    const settings = access || {};
    const signedIn = settings.signedIn === true;
    const ownershipReady = settings.status === "ready";
    const owned = signedIn && ownershipReady &&
      typeof settings.isOwned === "function" &&
      typeof product?.id === "string" && settings.isOwned(product.id) === true;

    if (owned) {
      return { state: "owned", action: "download", label: "Download", badge: "In your library", disabled: false };
    }
    if (product?.price_minor === 0) {
      return { state: "free", action: "download", label: "Download", badge: null, disabled: false };
    }
    if (!signedIn) {
      return { state: "signed_out", action: "signin", label: "Sign in to buy", badge: null, disabled: false };
    }
    if (settings.status === "loading") {
      return { state: "checking", action: null, label: "Checking access…", badge: null, disabled: true };
    }
    const checked = typeof settings.isChecked === "function" &&
      typeof product?.id === "string" && settings.isChecked(product.id) === true;
    if (!ownershipReady || (settings.complete === false && !checked)) {
      return {
        state: ownershipReady ? "unchecked" : "error",
        action: ownershipReady ? "check" : "retry",
        label: ownershipReady ? "Check access" : "Retry access",
        badge: null,
        disabled: false
      };
    }
    return { state: "available", action: "buy", label: "Buy", badge: null, disabled: false };
  }

  function bookByline(product) {
    if (!product) return "";
    if (typeof product.author_name === "string" && product.author_name.trim()) return product.author_name.trim();
    if (typeof product.creator_name === "string" && product.creator_name.trim()) return product.creator_name.trim();
    return "";
  }

  function renderCataloguePage(products, pageSize, renderProduct) {
    if (!Array.isArray(products) || typeof renderProduct !== "function") return 0;
    const page = products.slice(0, pageSize);
    page.forEach(function (product) {
      renderProduct(product);
    });
    return page.length;
  }

  async function runCatalogueStartup(tasks) {
    const options = tasks || {};
    const result = {
      facets: { status: "skipped" },
      catalogue: { status: "skipped" },
      discovery: { status: "skipped" },
      recentlyViewed: { status: "skipped" }
    };

    async function runOptional(key, task) {
      if (typeof task !== "function") return;
      try {
        await task();
        result[key] = { status: "loaded" };
      } catch (error) {
        result[key] = { status: "failed", error: error };
      }
    }

    await runOptional("facets", options.loadFacets);
    try {
      const catalogueResult = await options.loadCatalogue();
      result.catalogue = catalogueResult === false
        ? { status: "failed" }
        : { status: "loaded" };
    } catch (error) {
      result.catalogue = { status: "failed", error: error };
    }
    await runOptional("discovery", options.loadDiscovery);
    await runOptional("recentlyViewed", options.loadRecentlyViewed);
    return result;
  }

  const api = {
    buildSearchParameters: buildSearchParameters,
    bookByline: bookByline,
    formatPrice: formatPrice,
    amountFromMinor: amountFromMinor,
    priceMinor: priceMinor,
    productAccessDecision: productAccessDecision,
    rankRecommendations: rankRecommendations,
    relatedProducts: relatedProducts,
    renderCataloguePage: renderCataloguePage,
    runCatalogueStartup: runCatalogueStartup,
    shouldRefreshDownload: shouldRefreshDownload,
    signedPreviewUrl: signedPreviewUrl,
    validateCatalogueRows: validateCatalogueRows
  };
  root.BookWellMarketplaceCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
