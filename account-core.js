(function (root) {
  "use strict";

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function isSignedIn(session) {
    return Boolean(session && session.user && UUID_PATTERN.test(session.user.id));
  }

  function isEmailVerified(user) {
    return Boolean(user && (user.email_confirmed_at || user.confirmed_at));
  }

  function availability(isConfigured, clientLoaded) {
    if (!isConfigured) return "not-configured";
    if (!clientLoaded) return "client-unavailable";
    return "ready";
  }

  function savedProductRecord(session, productId) {
    if (!isSignedIn(session)) throw new Error("Sign in before saving a product.");
    if (typeof productId !== "string" || !UUID_PATTERN.test(productId)) {
      throw new Error("The product ID is invalid.");
    }
    return { user_id: session.user.id, product_id: productId };
  }

  function savedProductMutation(session, productId, currentlySaved) {
    const record = savedProductRecord(session, productId);
    return {
      operation: currentlySaved ? "delete" : "insert",
      record: record
    };
  }

  function ownPublishedSavedProducts(rows, userId) {
    if (!Array.isArray(rows) || !UUID_PATTERN.test(userId || "")) return [];
    return rows.filter((row) => row && row.user_id === userId &&
      row.product && row.product.status === "published");
  }

  function publishedLibraryProducts(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.filter((product) => product && product.status === "published");
  }

  const api = {
    availability: availability,
    isEmailVerified: isEmailVerified,
    isSignedIn: isSignedIn,
    ownPublishedSavedProducts: ownPublishedSavedProducts,
    publishedLibraryProducts: publishedLibraryProducts,
    savedProductRecord: savedProductRecord,
    savedProductMutation: savedProductMutation
  };
  root.BookWellAccountCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
