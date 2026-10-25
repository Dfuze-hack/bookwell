const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20261025185600_marketplace_foundation.sql"),
  "utf8"
);
const admin = fs.readFileSync(path.join(root, "admin.js"), "utf8");
const adminCore = require(path.join(root, "admin-core.js"));
const marketplaceCore = require(path.join(root, "marketplace-core.js"));
const adminCoreSource = fs.readFileSync(path.join(root, "admin-core.js"), "utf8");
const downloadFunction = fs.readFileSync(
  path.join(root, "supabase", "functions", "create-download", "index.ts"),
  "utf8"
);
const frontend = [
  fs.readFileSync(path.join(root, "index.html"), "utf8"),
  admin,
  fs.readFileSync(path.join(root, "marketplace.js"), "utf8"),
  fs.readFileSync(path.join(root, "supabase-config.js"), "utf8")
].join("\n");

test("client sessions cannot write administrator roles", () => {
  assert.match(migration, /alter table public\.user_roles enable row level security/i);
  assert.match(migration, /create policy "Admins manage roles" on public\.user_roles for all to authenticated/i);
  assert.match(migration, /grant select on public\.user_roles, public\.orders/i);
  assert.doesNotMatch(migration, /grant\s+(?:insert|update|delete|all)\s+on\s+public\.user_roles\s+to\s+(?:anon|authenticated)/i);
  assert.match(admin, /rpc\/has_role/);
  assert.match(admin, /required_role:\s*"admin"/);
});

test("administrator CRUD table grants remain protected by row-level policies", () => {
  assert.match(migration, /revoke all on public\.products from anon, authenticated/i);
  assert.match(migration, /grant select, insert, update, delete on public\.products to authenticated/i);
  assert.match(migration, /create policy "Admins manage products" on public\.products for all to authenticated using \(public\.has_role\('admin'\)\) with check \(public\.has_role\('admin'\)\)/i);
  assert.match(migration, /create policy "Creators submit drafts"[\s\S]*?public\.has_role\('creator'\)/i);
});

test("paid products stay out of public catalogue and cannot be published", () => {
  assert.match(migration, /where p\.status = 'published'\s+and p\.price_minor = 0/i);
  assert.match(migration, /p\.slug = p_slug and p\.status = 'published' and p\.price_minor = 0/i);
  assert.match(migration, /products_published_free_only check \(status <> 'published' or price_minor = 0\)/i);
  assert.match(adminCoreSource, /Paid listings cannot be published until verified checkout/i);
});

test("product files are private and preview uploads use a separate bucket", () => {
  assert.match(migration, /values \('product-files', 'product-files', false, 52428800/i);
  assert.match(migration, /create policy "Admins manage product files"[\s\S]*?public\.has_role\('admin'\)/i);
  assert.match(migration, /values \('product-previews', 'product-previews', false, 2097152/i);
  assert.match(migration, /create policy "Published free product previews are readable"[\s\S]*?p\.status = 'published'[\s\S]*?p\.price_minor = 0[\s\S]*?c\.is_active/i);
  assert.match(migration, /create policy "Admins manage product previews"[\s\S]*?public\.has_role\('admin'\)/i);
  assert.match(admin, /validateFile/);
  assert.match(admin, /50 \* 1024 \* 1024/);
  assert.match(admin, /2 \* 1024 \* 1024/);
  assert.match(migration, /on conflict \(id\) do nothing;[\s\S]*?Existing product-files bucket does not match/i);
  assert.match(migration, /Existing product-previews bucket does not match/i);
  assert.match(admin, /product\.preview_path = previewPath/);
  assert.doesNotMatch(admin, /product\.preview_url/);
  assert.match(frontend, /storage\/v1\/object\/sign\/product-previews/);
  assert.doesNotMatch(frontend, /storage\/v1\/object\/public\/product-previews/);
  assert.match(migration, /preview_url text check \(preview_url is null\)/i);
  assert.match(migration, /license text, preview_path text, price_minor integer/i);
});

test("administrator UI uses Auth tokens and never persists them", () => {
  assert.match(admin, /auth\/v1\/token\?grant_type=password/);
  assert.match(admin, /Authorization", "Bearer " \+ accessToken/);
  assert.match(admin, /setAuthenticated\(result\.user\)/);
  assert.doesNotMatch(admin, /localStorage|sessionStorage/);
  assert.match(admin, /method: existing \? "PATCH" : "POST"/);
  assert.match(admin, /method: "DELETE"/);
  assert.match(adminCoreSource, /Paid listings cannot be published/i);
  assert.match(admin, /productStatus: document\.getElementById\("admin-product-status"\)/);
  assert.match(admin, /elements\.productStatus\.value = product\?\.status/);
});

test("browser assets do not contain server-only credentials", () => {
  assert.doesNotMatch(frontend, /SUPABASE_SERVICE_ROLE_KEY|service_role|webhook_secret/i);
  assert.doesNotMatch(frontend, /checkout success|payment succeeded/i);
});

test("catalogue query construction preserves filters, INR prices, sorting, and pagination", () => {
  const parameters = marketplaceCore.buildSearchParameters({
    search: "  algebra  ",
    category: "study-resources",
    priceType: "free",
    fileFormat: "PDF",
    sort: "price_asc",
    minPrice: "0",
    maxPrice: "125.50"
  }, 12, 24);
  assert.deepEqual(parameters, {
    p_search: "algebra",
    p_category: "study-resources",
    p_price_type: "free",
    p_file_format: "PDF",
    p_sort: "price_asc",
    p_limit: 13,
    p_offset: 24,
    p_min_price_minor: 0,
    p_max_price_minor: 12550,
    p_currency: "INR"
  });
  assert.throws(() => marketplaceCore.buildSearchParameters({
    search: "", category: "", priceType: "", fileFormat: "", sort: "newest",
    minPrice: "10", maxPrice: "9"
  }, 12, 0), /Minimum price cannot be greater/);
});

test("catalogue response validation rejects malformed rows and accepts valid products", () => {
  const product = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    title: "Algebra notes",
    slug: "algebra-notes",
    tags: [],
    formats: ["PDF"],
    price_minor: 0,
    currency: "INR"
  };
  assert.deepEqual(marketplaceCore.validateCatalogueRows([product]), [product]);
  assert.throws(() => marketplaceCore.validateCatalogueRows({}), /invalid response/);
  assert.throws(() => marketplaceCore.validateCatalogueRows([{ ...product, price_minor: -1 }]), /invalid product/);
});

test("product form validation normalizes metadata and blocks paid publication", () => {
  const fields = {
    title: "  Algebra Notes ",
    slug: "algebra-notes",
    description: "Concise revision notes for algebra.",
    license: "CC BY 4.0",
    tags: "math, algebra",
    formats: ["PDF", "INVALID"],
    price: "0",
    status: "draft"
  };
  const normalized = adminCore.validateProductFields(fields);
  assert.equal(normalized.title, "Algebra Notes");
  assert.deepEqual(normalized.tags, ["math", "algebra"]);
  assert.deepEqual(normalized.formats, ["PDF"]);
  assert.equal(normalized.price_minor, 0);
  assert.throws(() => adminCore.validateProductFields({ ...fields, price: "10.00", status: "published" }), /Paid listings cannot be published/);
  assert.throws(() => adminCore.validateProductFields({ ...fields, price: "10.001" }), /Price must be/);
  assert.throws(() => adminCore.validateProductFields({ ...fields, slug: "../bad" }), /slug/);
});

test("file validation checks byte signatures, permitted extensions, and size limits", async () => {
  function file(name, content, size) {
    const bytes = Uint8Array.from(content);
    return {
      name,
      size: size === undefined ? bytes.length : size,
      slice: () => ({ arrayBuffer: async () => bytes.buffer })
    };
  }
  assert.deepEqual(
    await adminCore.validateFile(file("notes.pdf", [0x25, 0x50, 0x44, 0x46, 0x2d]), adminCore.productTypes, 50 * 1024 * 1024, "Product file"),
    { extension: "pdf", mime: "application/pdf" }
  );
  await assert.rejects(
    adminCore.validateFile(file("notes.pdf", [0, 1, 2]), adminCore.productTypes, 50 * 1024 * 1024, "Product file"),
    /does not match/
  );
  await assert.rejects(
    adminCore.validateFile(file("notes.exe", [0x25, 0x50, 0x44, 0x46, 0x2d]), adminCore.productTypes, 50 * 1024 * 1024, "Product file"),
    /unsupported extension/
  );
  await assert.rejects(
    adminCore.validateFile(file("notes.pdf", [0x25, 0x50, 0x44, 0x46, 0x2d], 51 * 1024 * 1024), adminCore.productTypes, 50 * 1024 * 1024, "Product file"),
    /must be between/
  );
});

test("download authorization is checked before issuing a short-lived URL", () => {
  const lookup = downloadFunction.indexOf('"get_authorized_download_path"');
  const signed = downloadFunction.indexOf("createSignedUrl(filePath, 60)");
  assert.notEqual(lookup, -1);
  assert.notEqual(signed, -1);
  assert.ok(lookup < signed);
  assert.match(migration, /where p\.id = target_product\s+and p\.status = 'published'\s+and public\.can_download_product\(p\.id\)/i);
  assert.match(migration, /p\.price_minor = 0\s+or p\.creator_id = \(select auth\.uid\(\)\)/i);
  assert.match(downloadFunction, /if \(accessError \|\| typeof filePath !== "string" \|\| filePath\.length === 0\)/);
  assert.match(downloadFunction, /createSignedUrl\(filePath, 60\)/);
  assert.match(downloadFunction, /extension: extension/);
  assert.match(downloadFunction, /console\.error\("Storage could not issue an authorized download\."\)/);
  assert.doesNotMatch(downloadFunction, /console\.(?:log|error)\([^)]*signedUrl/i);
  assert.equal(marketplaceCore.shouldRefreshDownload({ status: 403 }), true);
  assert.equal(marketplaceCore.shouldRefreshDownload({ status: 404 }), false);
  assert.match(fs.readFileSync(path.join(root, "marketplace.js"), "utf8"), /downloadResponse = await fetch\(issuedLink\.url\)/);
});

test("administrator preview button is local-only and does not publish a record", () => {
  assert.match(admin, /async function previewListing\(\)/);
  assert.match(admin, /Administrator preview only\. This listing is not published by previewing it\./);
  assert.match(admin, /elements\.previewDialog\.showModal\(\)/);
  assert.match(admin, /admin-preview-listing/);
  assert.match(migration, /products_published_free_only check/);
});

test("catalogue and preview requests cannot expose private file paths", () => {
  assert.match(migration, /returns table \([\s\S]*?license text, preview_path text, price_minor integer/i);
  assert.doesNotMatch(migration.slice(migration.indexOf("create or replace function public.search_public_products"), migration.indexOf("create or replace function public.creator_profile_is_public")), /file_path/i);
  assert.doesNotMatch(migration.slice(migration.indexOf("create or replace function public.public_product_by_slug"), migration.indexOf("create or replace function public.can_download_product")), /file_path/i);
  assert.match(migration, /values \('product-files', 'product-files', false/);
  assert.match(fs.readFileSync(path.join(root, "marketplace.js"), "utf8"), /functions\/v1\/create-download/);
});
