(function (root) {
  "use strict";

  const allowedFormats = ["PDF", "ZIP", "DOCX", "PPTX", "XLSX"];
  const allowedCurrencies = ["USD", "INR", "EUR", "GBP", "AUD", "JPY", "KWD"];
  const productFileLimitBytes = 50 * 1024 * 1024;
  const previewFileLimitBytes = 2 * 1024 * 1024;
  const productTypes = {
    pdf: { mime: "application/pdf", mimes: ["application/pdf"], signature: [0x25, 0x50, 0x44, 0x46, 0x2d] },
    zip: {
      mime: "application/zip",
      mimes: ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
      signature: [0x50, 0x4b, 0x03, 0x04]
    },
    docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"], signature: [0x50, 0x4b, 0x03, 0x04] },
    pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", mimes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"], signature: [0x50, 0x4b, 0x03, 0x04] },
    xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", mimes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], signature: [0x50, 0x4b, 0x03, 0x04] }
  };
  const previewTypes = {
    png: { mime: "image/png", mimes: ["image/png"], signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    jpg: { mime: "image/jpeg", mimes: ["image/jpeg"], signature: [0xff, 0xd8, 0xff] },
    jpeg: { mime: "image/jpeg", mimes: ["image/jpeg"], signature: [0xff, 0xd8, 0xff] },
    webp: { mime: "image/webp", mimes: ["image/webp"], signature: [0x52, 0x49, 0x46, 0x46], webp: true }
  };

  function validateProductFields(fields) {
    const title = String(fields.title || "").trim();
    const slug = String(fields.slug || "").trim();
    const description = String(fields.description || "").trim();
    const language = String(fields.language || "").trim();
    const license = String(fields.license || "").trim();
    const tags = Array.isArray(fields.tags) ? fields.tags : String(fields.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean);
    const formats = Array.isArray(fields.formats) ? fields.formats.filter((format) => allowedFormats.includes(format)) : [];
    const priceText = String(fields.price);
    const price = Number(priceText);
    const currency = String(fields.currency || "");
    if (title.length < 3 || title.length > 160) throw new Error("Product title must be 3 to 160 characters.");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("Use a lowercase URL slug with letters, numbers and hyphens.");
    if (description.length < 10 || description.length > 10000) throw new Error("Description must be 10 to 10,000 characters.");
    if (language.length < 2 || language.length > 80) throw new Error("Enter the product's language (2 to 80 characters).");
    if (!license || license.length > 120) throw new Error("Enter a valid product licence.");
    if (tags.length > 30 || tags.some((tag) => tag.length > 50)) throw new Error("Use at most 30 tags, each no longer than 50 characters.");
    if (formats.length === 0) throw new Error("Select at least one supported file format.");
    if (!allowedCurrencies.includes(currency)) throw new Error("Select a supported ISO currency code.");
    const digits = new Intl.NumberFormat("en", { style: "currency", currency: currency }).resolvedOptions().maximumFractionDigits;
    const decimalPattern = digits ? "(?:\\.\\d{1," + digits + "})?" : "";
    const maximumPrice = Math.min(20000000, 2147483647 / Math.pow(10, digits));
    if (!(new RegExp("^\\d+" + decimalPattern + "$")).test(priceText) ||
        !Number.isFinite(price) || price < 0 || price > maximumPrice) {
      throw new Error("Price is invalid, exceeds the database's supported range, or uses too many decimal places for the selected currency.");
    }
    const status = String(fields.status || "");
    if (!["draft", "pending", "published", "archived", "rejected"].includes(status)) {
      throw new Error("Select a valid listing status.");
    }
    const priceMinor = Math.round(price * Math.pow(10, digits));
    return {
      title: title,
      slug: slug,
      description: description,
      language: language,
      license: license,
      tags: tags,
      formats: formats,
      currency: currency,
      price_minor: priceMinor,
      status: status
    };
  }

  function optionalText(value, maximum, label) {
    const text = String(value || "").trim();
    if (!text) return null;
    if (text.length > maximum) throw new Error(label + " must be at most " + maximum + " characters.");
    return text;
  }

  function validateBookFields(fields) {
    const authorName = optionalText(fields.authorName, 160, "Author name");
    const subtitle = optionalText(fields.subtitle, 200, "Subtitle");
    const edition = optionalText(fields.edition, 80, "Edition");
    const isbnRaw = String(fields.isbn || "").trim();
    const isbnDigits = isbnRaw.replace(/[-\s]/g, "");
    let isbn = null;
    if (isbnRaw) {
      if (!/^[0-9Xx]{10}$|^[0-9]{13}$/.test(isbnDigits)) {
        throw new Error("ISBN must be 10 or 13 characters, using digits and optional hyphens.");
      }
      isbn = isbnRaw;
    }
    const yearText = String(fields.publicationYear || "").trim();
    let publicationYear = null;
    if (yearText) {
      if (!/^\d{4}$/.test(yearText)) throw new Error("Publication year must be a 4-digit year.");
      publicationYear = Number(yearText);
      if (publicationYear < 1000 || publicationYear > 2100) {
        throw new Error("Publication year must be between 1000 and 2100.");
      }
    }
    const pageText = String(fields.pageCount || "").trim();
    let pageCount = null;
    if (pageText) {
      if (!/^[1-9]\d{0,5}$/.test(pageText)) throw new Error("Page count must be a whole number of at least 1.");
      pageCount = Number(pageText);
      if (pageCount > 100000) throw new Error("Page count cannot exceed 100,000.");
    }
    return {
      author_name: authorName,
      subtitle: subtitle,
      publication_year: publicationYear,
      edition: edition,
      isbn: isbn,
      page_count: pageCount
    };
  }

  function permittedStatuses(role) {
    if (role === "admin") return ["draft", "pending", "published", "archived", "rejected"];
    if (role === "creator") return ["draft", "pending"];
    return [];
  }

  function canEditListing(role, product) {
    if (role === "admin") return true;
    if (role !== "creator") return false;
    if (!product) return true;
    return ["draft", "pending", "rejected"].includes(product.status);
  }

  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
    if (bytes < 1024) return bytes + " bytes";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  async function validateFile(file, types, maximumBytes, label) {
    if (!file) return null;
    if (file.size <= 0 || file.size > maximumBytes) {
      throw new Error(label + " must be between 1 byte and " + Math.floor(maximumBytes / 1024 / 1024) + " MB.");
    }
    const match = file.name.toLowerCase().match(/\.([a-z0-9]+)$/);
    const extension = match ? match[1] : "";
    const definition = types[extension];
    if (!definition) throw new Error(label + " has an unsupported extension or content type.");
    const declaredType = String(file.type || "").trim().toLowerCase();
    if (declaredType && Array.isArray(definition.mimes) && !definition.mimes.includes(declaredType)) {
      throw new Error(label + " declared type does not match its file extension.");
    }
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (!definition.signature.every((value, index) => bytes[index] === value)) {
      throw new Error(label + " content does not match its file extension.");
    }
    if (definition.webp && String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP") {
      throw new Error(label + " is not a valid WebP image.");
    }
    return { extension: extension === "jpeg" ? "jpg" : extension, mime: definition.mime };
  }

  function filterProducts(products, filter, userId) {
    if (!Array.isArray(products)) throw new Error("Products must be a list.");
    if (filter === "all") return products.slice();
    if (filter === "mine") return products.filter((product) => product.creator_id === userId);
    if (!["draft", "published", "archived"].includes(filter)) {
      throw new Error("Choose a valid Creator Studio product view.");
    }
    return products.filter((product) => product.status === filter);
  }

  function metricValue(value) {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : "Unavailable";
  }

  const api = {
    productTypes: productTypes,
    previewTypes: previewTypes,
    productFileLimitBytes: productFileLimitBytes,
    previewFileLimitBytes: previewFileLimitBytes,
    validateFile: validateFile,
    validateProductFields: validateProductFields,
    validateBookFields: validateBookFields,
    permittedStatuses: permittedStatuses,
    canEditListing: canEditListing,
    formatFileSize: formatFileSize,
    filterProducts: filterProducts,
    metricValue: metricValue
  };
  root.BookWellAdminCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
