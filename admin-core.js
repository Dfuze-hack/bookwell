(function (root) {
  "use strict";

  const allowedFormats = ["PDF", "ZIP", "DOCX", "PPTX", "XLSX"];
  const productTypes = {
    pdf: { mime: "application/pdf", signature: [0x25, 0x50, 0x44, 0x46, 0x2d] },
    zip: { mime: "application/zip", signature: [0x50, 0x4b, 0x03, 0x04] },
    docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", signature: [0x50, 0x4b, 0x03, 0x04] },
    pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", signature: [0x50, 0x4b, 0x03, 0x04] },
    xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", signature: [0x50, 0x4b, 0x03, 0x04] }
  };
  const previewTypes = {
    png: { mime: "image/png", signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    jpg: { mime: "image/jpeg", signature: [0xff, 0xd8, 0xff] },
    jpeg: { mime: "image/jpeg", signature: [0xff, 0xd8, 0xff] },
    webp: { mime: "image/webp", signature: [0x52, 0x49, 0x46, 0x46], webp: true }
  };

  function validateProductFields(fields) {
    const title = String(fields.title || "").trim();
    const slug = String(fields.slug || "").trim();
    const description = String(fields.description || "").trim();
    const license = String(fields.license || "").trim();
    const tags = Array.isArray(fields.tags) ? fields.tags : String(fields.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean);
    const formats = Array.isArray(fields.formats) ? fields.formats.filter((format) => allowedFormats.includes(format)) : [];
    const priceText = String(fields.price);
    const price = Number(priceText);
    if (title.length < 3 || title.length > 160) throw new Error("Product title must be 3 to 160 characters.");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("Use a lowercase URL slug with letters, numbers and hyphens.");
    if (description.length < 10 || description.length > 10000) throw new Error("Description must be 10 to 10,000 characters.");
    if (!license || license.length > 120) throw new Error("Enter a valid product licence.");
    if (tags.length > 30 || tags.some((tag) => tag.length > 50)) throw new Error("Use at most 30 tags, each no longer than 50 characters.");
    if (formats.length === 0) throw new Error("Select at least one supported file format.");
    if (!/^\d+(?:\.\d{1,2})?$/.test(priceText) || !Number.isFinite(price) || price < 0 || price > 20000000) {
      throw new Error("Price must be between ₹0 and ₹20,000,000 with no more than two decimal places.");
    }
    const status = String(fields.status || "");
    if (!["draft", "pending", "published", "archived", "rejected"].includes(status)) {
      throw new Error("Select a valid listing status.");
    }
    const priceMinor = Math.round(price * 100);
    if (status === "published" && priceMinor !== 0) {
      throw new Error("Paid listings cannot be published until verified checkout and payment webhooks are implemented.");
    }
    return {
      title: title,
      slug: slug,
      description: description,
      license: license,
      tags: tags,
      formats: formats,
      price_minor: priceMinor,
      status: status
    };
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
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (!definition.signature.every((value, index) => bytes[index] === value)) {
      throw new Error(label + " content does not match its file extension.");
    }
    if (definition.webp && String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP") {
      throw new Error(label + " is not a valid WebP image.");
    }
    return { extension: extension === "jpeg" ? "jpg" : extension, mime: definition.mime };
  }

  const api = {
    productTypes: productTypes,
    previewTypes: previewTypes,
    validateFile: validateFile,
    validateProductFields: validateProductFields
  };
  root.BookWellAdminCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
