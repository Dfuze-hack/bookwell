(function (root) {
  "use strict";

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function purchaseState(purchase) {
    if (!purchase || purchase.status === "pending") return "pending";
    if (purchase.status === "paid" && purchase.verified_at) return "verified";
    if (purchase.status === "paid") return "pending";
    if (purchase.status === "failed") return "failed";
    if (purchase.status === "cancelled") return "cancelled";
    if (purchase.status === "partially_refunded") return "partially_refunded";
    if (purchase.status === "refunded") return "refunded";
    return "unknown";
  }

  function purchaseDownloadProduct(purchase, libraryProducts) {
    if (purchaseState(purchase) !== "verified" ||
        !Array.isArray(purchase.order_items) || !Array.isArray(libraryProducts)) {
      return null;
    }
    for (const item of purchase.order_items) {
      if (Number.isSafeInteger(item?.unit_price_minor) &&
          Number.isSafeInteger(item?.refunded_minor) &&
          item.refunded_minor >= item.unit_price_minor) continue;
      const productId = item?.product_id || item?.product?.id;
      if (!UUID_PATTERN.test(productId || "")) continue;
      const product = libraryProducts.find((candidate) => candidate && candidate.id === productId);
      if (product) return product;
    }
    return null;
  }

  function checkoutUrl(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("The checkout service returned an invalid link.");
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("The checkout service returned an unsafe link.");
    }
    return url.href;
  }

  const api = {
    checkoutUrl: checkoutUrl,
    purchaseDownloadProduct: purchaseDownloadProduct,
    purchaseState: purchaseState
  };
  root.BookWellCommerceCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
