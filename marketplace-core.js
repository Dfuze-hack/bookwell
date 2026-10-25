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
          !Number.isSafeInteger(product.price_minor) || product.price_minor < 0 ||
          typeof product.currency !== "string" || !/^[A-Z]{3}$/.test(product.currency)) {
        throw new Error("The product catalog returned an invalid product.");
      }
    });
    return rows;
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

  const api = {
    buildSearchParameters: buildSearchParameters,
    formatPrice: formatPrice,
    amountFromMinor: amountFromMinor,
    priceMinor: priceMinor,
    shouldRefreshDownload: shouldRefreshDownload,
    signedPreviewUrl: signedPreviewUrl,
    validateCatalogueRows: validateCatalogueRows
  };
  root.BookWellMarketplaceCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
