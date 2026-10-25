(function (root) {
  "use strict";

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

  const api = { checkoutUrl: checkoutUrl, purchaseState: purchaseState };
  root.BookWellCommerceCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
