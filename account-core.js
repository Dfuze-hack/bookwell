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

  function isRecoveryRequest(search) {
    try {
      return new URLSearchParams(String(search || "")).get("recovery") === "1";
    } catch {
      return false;
    }
  }

  function recoveryRedirectUrl(baseUrl) {
    const url = new URL("signin.html", baseUrl);
    url.searchParams.set("recovery", "1");
    return url.href;
  }

  function recoveryState(event, session, recoveryRequested) {
    if (event === "PASSWORD_RECOVERY") {
      return isSignedIn(session) ? "reset" : "invalid";
    }
    if (!recoveryRequested) return "none";
    if (isSignedIn(session)) return "reset";
    if (event === "INITIAL_SESSION" || event === "SIGNED_OUT") return "invalid";
    return "pending";
  }

  function accountNavigation(session) {
    if (isSignedIn(session) && isEmailVerified(session.user)) {
      return { label: "Account", href: "#account" };
    }
    return { label: "Sign In", href: "signin.html" };
  }

  function isProductId(value) {
    return typeof value === "string" && UUID_PATTERN.test(value);
  }

  function savedProductRecord(session, productId) {
    if (!isSignedIn(session)) throw new Error("Sign in before saving a product.");
    if (!isProductId(productId)) throw new Error("The product ID is invalid.");
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

  function libraryProducts(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.filter((product) => Boolean(product));
  }

  const LIBRARY_SECTIONS = {
    purchases: {
      rpc: "list_my_purchase_products",
      cursorArgument: "p_before_purchased_at",
      orderField: "purchased_at"
    },
    free: {
      rpc: "list_my_free_downloads",
      cursorArgument: "p_before_created_at",
      orderField: "created_at"
    },
    additional: {
      rpc: "list_my_additional_access_products",
      cursorArgument: "p_before_created_at",
      orderField: "created_at"
    }
  };

  function libraryPageSize(value) {
    if (!Number.isInteger(value) || value < 1) return 24;
    return Math.min(value, 49);
  }

  function librarySectionConfig(section) {
    const config = LIBRARY_SECTIONS[section];
    if (!config) throw new Error("The library section is invalid.");
    return config;
  }

  function libraryPageRequest(section, cursor, pageSize) {
    const config = librarySectionConfig(section);
    const size = libraryPageSize(pageSize);
    const args = { p_limit: size + 1 };
    if (cursor !== null && cursor !== undefined) {
      if (!cursor || !isProductId(cursor.id) ||
          typeof cursor.orderedAt !== "string" || !cursor.orderedAt) {
        throw new Error("The library cursor is invalid.");
      }
      args[config.cursorArgument] = cursor.orderedAt;
      args.p_before_product_id = cursor.id;
    }
    return { rpc: config.rpc, args: args };
  }

  function libraryPage(rows, pageSize, section) {
    const config = librarySectionConfig(section);
    const size = libraryPageSize(pageSize);
    if (!Array.isArray(rows) || rows.some((row) => !row || !isProductId(row.id))) {
      throw new Error("The library returned an invalid page.");
    }
    const pageRows = rows.slice(0, size);
    const hasMore = rows.length > size;
    let cursor = null;
    if (hasMore) {
      const last = pageRows[pageRows.length - 1];
      const orderedAt = last?.[config.orderField];
      if (typeof orderedAt !== "string" || !orderedAt) {
        throw new Error("The library page is missing its ordering cursor.");
      }
      cursor = { orderedAt: orderedAt, id: last.id };
    }
    return { rows: pageRows, cursor: cursor, hasMore: hasMore };
  }

  function mergeLibraryRows(current, incoming) {
    const merged = [];
    const seen = new Set();
    [current, incoming].forEach((rows) => {
      if (!Array.isArray(rows)) return;
      rows.forEach((row) => {
        if (!row || !isProductId(row.id) || seen.has(row.id)) return;
        seen.add(row.id);
        merged.push(row);
      });
    });
    return merged;
  }

  const api = {
    accountNavigation: accountNavigation,
    availability: availability,
    isEmailVerified: isEmailVerified,
    isProductId: isProductId,
    isRecoveryRequest: isRecoveryRequest,
    isSignedIn: isSignedIn,
    libraryPage: libraryPage,
    libraryPageRequest: libraryPageRequest,
    libraryProducts: libraryProducts,
    mergeLibraryRows: mergeLibraryRows,
    ownPublishedSavedProducts: ownPublishedSavedProducts,
    recoveryRedirectUrl: recoveryRedirectUrl,
    recoveryState: recoveryState,
    savedProductRecord: savedProductRecord,
    savedProductMutation: savedProductMutation
  };
  root.BookWellAccountCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
