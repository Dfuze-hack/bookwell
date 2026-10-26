const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const migration = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20261025185600_marketplace_foundation.sql"),
  "utf8"
);
const accountMigration = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20261025204000_user_accounts.sql"),
  "utf8"
);
const commerceMigration = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20261025205700_commerce_foundation.sql"),
  "utf8"
);
const discoveryMigration = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20261026120000_smart_discovery.sql"),
  "utf8"
);
const admin = fs.readFileSync(path.join(root, "admin.js"), "utf8");
const adminCore = require(path.join(root, "admin-core.js"));
const account = fs.readFileSync(path.join(root, "account.js"), "utf8");
const accountCore = require(path.join(root, "account-core.js"));
const marketplaceCore = require(path.join(root, "marketplace-core.js"));
const adminCoreSource = fs.readFileSync(path.join(root, "admin-core.js"), "utf8");
const downloadFunction = fs.readFileSync(
  path.join(root, "supabase", "functions", "create-download", "index.ts"),
  "utf8"
);
const checkoutFunction = fs.readFileSync(
  path.join(root, "supabase", "functions", "create-checkout", "index.ts"),
  "utf8"
);
const webhookFunction = fs.readFileSync(
  path.join(root, "supabase", "functions", "payment-webhook", "index.ts"),
  "utf8"
);
const paymentProvider = fs.readFileSync(
  path.join(root, "supabase", "functions", "_shared", "payment-provider.ts"),
  "utf8"
);
const commerceCore = require(path.join(root, "commerce-core.js"));
const frontend = [
  fs.readFileSync(path.join(root, "index.html"), "utf8"),
  fs.readFileSync(path.join(root, "signin.html"), "utf8"),
  fs.readFileSync(path.join(root, "signin.js"), "utf8"),
  admin,
  account,
  fs.readFileSync(path.join(root, "account-client.js"), "utf8"),
  fs.readFileSync(path.join(root, "account-core.js"), "utf8"),
  fs.readFileSync(path.join(root, "commerce-core.js"), "utf8"),
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

test("Creator Studio remains administrator-only until creator storage permissions are designed", () => {
  assert.match(admin, /required_role:\s*"admin"/);
  assert.match(migration, /create policy "Creators submit drafts"[\s\S]*?status in \('draft', 'pending'\)/i);
  assert.match(migration, /create policy "Creators edit own unapproved products"[\s\S]*?status in \('draft', 'pending', 'rejected'\)/i);
  assert.match(migration, /create policy "Admins manage product files" on storage\.objects\s+for all to authenticated using \(bucket_id = 'product-files' and public\.has_role\('admin'\)\)/i);
  assert.match(migration, /create policy "Admins manage product previews" on storage\.objects\s+for all to authenticated using \(bucket_id = 'product-previews' and public\.has_role\('admin'\)\)/i);
  assert.match(fs.readFileSync(path.join(root, "index.html"), "utf8"), /restricted to authorized administrators/);
  assert.match(admin, /fillForm\(product, true\)/);
  assert.match(admin, /creator_id: productById\.get\(id\)\?\.creator_id \|\| signedInUser\.id/);
});

test("Creator Studio product filters, exact metrics and product metadata are validated", () => {
  const products = [
    { id: "draft-1", status: "draft" },
    { id: "published-1", status: "published" },
    { id: "archived-1", status: "archived" }
  ];
  const owned = products.map((product) => ({ ...product, creator_id: "admin-user" }));
  assert.deepEqual(adminCore.filterProducts(owned, "mine", "admin-user"), owned);
  assert.deepEqual(adminCore.filterProducts(owned, "mine", "different-user"), []);
  assert.deepEqual(adminCore.filterProducts(products, "draft"), [products[0]]);
  assert.deepEqual(adminCore.filterProducts(products, "published"), [products[1]]);
  assert.deepEqual(adminCore.filterProducts(products, "archived"), [products[2]]);
  assert.equal(adminCore.metricValue(0), "0");
  assert.equal(adminCore.metricValue(null), "Unavailable");
  assert.match(admin, /Prefer:\s*"count=exact"/);
  assert.match(admin, /download_events\?select=id/);
  assert.match(admin, /verified_at=not\.is\.null/);
  assert.match(admin, /language: data\.get\("language"\)/);
  assert.match(admin, /language: fields\.language/);
  assert.match(fs.readFileSync(path.join(root, "index.html"), "utf8"), /Link issuance is not a confirmed download/);
  assert.match(commerceMigration, /add column language text check \(language is null or length\(trim\(language\)\) between 2 and 80\)/i);
  assert.match(commerceMigration, /license text, preview_path text, price_minor integer, currency text, language text/i);
});

test("initial marketplace migration blocks paid publication until commerce migration", () => {
  assert.match(migration, /where p\.status = 'published'\s+and p\.price_minor = 0/i);
  assert.match(migration, /p\.slug = p_slug and p\.status = 'published' and p\.price_minor = 0/i);
  assert.match(migration, /products_published_free_only check \(status <> 'published' or price_minor = 0\)/i);
  assert.match(commerceMigration, /drop constraint if exists products_published_free_only/i);
  assert.match(commerceMigration, /p\.status = 'published'\s+and c\.is_active/i);
  assert.match(commerceMigration, /p_price_type = 'paid' and p\.price_minor > 0/i);
  assert.doesNotMatch(commerceMigration, /where p\.status = 'published'\s+and p\.price_minor = 0/i);
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
  assert.match(commerceMigration, /revoke all on public\.products from public, anon, authenticated/i);
  assert.match(commerceMigration, /grant select \([\s\S]*?preview_path, price_minor, currency[\s\S]*?\) on public\.products to anon, authenticated/i);
  assert.doesNotMatch(commerceMigration.match(/grant select \([\s\S]*?\) on public\.products to anon, authenticated/i)?.[0] || "", /file_path/i);
  assert.match(commerceMigration, /public\.admin_list_products\(\)/i);
  assert.match(commerceMigration, /where public\.has_role\('admin'\)/i);
  assert.match(commerceMigration, /create policy "Published product previews are readable"[\s\S]*?p\.status = 'published'[\s\S]*?p\.price_minor = 0[\s\S]*?c\.is_active/i);
  assert.match(commerceMigration, /verified_status = 'refunded' and refunded_amount_minor <> payment_item\.unit_price_minor/i);
  assert.match(commerceMigration, /verified_status = 'partially_refunded' and refunded_amount_minor >= payment_item\.unit_price_minor/i);
  assert.match(admin, /rpc\/admin_list_products/);
});

test("administrator UI uses Auth tokens and never persists them", () => {
  assert.match(admin, /auth\/v1\/token\?grant_type=password/);
  assert.match(admin, /Authorization", "Bearer " \+ accessToken/);
  assert.match(admin, /setAuthenticated\(result\.user\)/);
  assert.doesNotMatch(admin, /localStorage|sessionStorage/);
  assert.match(admin, /method: existing \? "PATCH" : "POST"/);
  assert.match(admin, /method: "DELETE"/);
  assert.doesNotMatch(adminCoreSource, /Paid listings cannot be published/i);
  assert.match(admin, /productStatus: document\.getElementById\("admin-product-status"\)/);
  assert.match(admin, /elements\.productStatus\.value = duplicate \? "draft" : \(product\?\.status \|\| "draft"\)/);
});

test("private uploads report transfer progress and leave a clear retry path on failure", () => {
  assert.match(admin, /xhr\.upload\.addEventListener\("progress"/);
  assert.match(admin, /xhr\.status >= 200 && xhr\.status < 300/);
  assert.match(admin, /xhr\.addEventListener\("error"/);
  assert.match(admin, /confirmed by Storage/);
  assert.match(admin, /Upload failed\. Select Save listing to retry/);
  assert.match(admin, /validateFile\(productFile, core\.productTypes, 50 \* 1024 \* 1024/);
  assert.match(admin, /validateFile\(previewFile, core\.previewTypes, 2 \* 1024 \* 1024/);
});

test("browser assets do not contain server-only credentials", () => {
  assert.doesNotMatch(frontend, /SUPABASE_SERVICE_ROLE_KEY|service_role|webhook_secret/i);
  assert.doesNotMatch(frontend, /checkout success|payment succeeded/i);
});

test("account auth uses Supabase sessions and handles signed-out and configured states", () => {
  const session = { user: { id: "550e8400-e29b-41d4-a716-446655440000" } };
  assert.equal(accountCore.isSignedIn(session), true);
  assert.equal(accountCore.isSignedIn(null), false);
  assert.equal(accountCore.isSignedIn({ user: { id: "not-a-user-id" } }), false);
  assert.equal(accountCore.isEmailVerified({ email_confirmed_at: "2026-01-01T00:00:00Z" }), true);
  assert.equal(accountCore.isEmailVerified({ email_confirmed_at: null }), false);
  assert.equal(accountCore.availability(false, false), "not-configured");
  assert.equal(accountCore.availability(true, false), "client-unavailable");
  assert.equal(accountCore.availability(true, true), "ready");
  assert.match(frontend, /signInWithPassword/);
  assert.match(frontend, /auth\.signUp/);
  assert.match(frontend, /resetPasswordForEmail/);
  assert.match(frontend, /auth\.resend/);
  assert.match(frontend, /auth\.signOut/);
  assert.match(frontend, /persistSession:\s*true/);
  assert.match(frontend, /autoRefreshToken:\s*true/);
  assert.match(frontend, /flowType:\s*"pkce"/);
  assert.match(frontend, /PASSWORD_RECOVERY/);
});

test("sign-in page owns the user auth forms and the homepage sends users there", () => {
  const signInPage = fs.readFileSync(path.join(root, "signin.html"), "utf8");
  const signInScript = fs.readFileSync(path.join(root, "signin.js"), "utf8");
  assert.match(index, /href="signin\.html" id="account-nav" class="nav-signin">Sign In/);
  assert.match(index, /<div id="account-auth" hidden>/);
  assert.match(account, /const inlineAuthEnabled = document\.body\.hasAttribute\("data-inline-auth"\)/);
  assert.match(account, /elements\.auth\.hidden = !inlineAuthEnabled \|\| Boolean\(currentUser\)/);
  assert.match(signInPage, /id="account-signin"/);
  assert.match(signInPage, /id="account-signup"/);
  assert.match(signInPage, /src="signin-student\.svg" alt="A student sitting on books and learning on her laptop"/);
  assert.match(signInPage, /\.auth-form > p:not\(\.auth-switch\)/);
  assert.match(signInPage, /id="account-forgot"/);
  assert.match(signInPage, /src="signin\.js" defer/);
  assert.match(signInScript, /client\.auth\.signInWithPassword/);
  assert.match(signInScript, /client\.auth\.signUp/);
  assert.match(signInScript, /client\.auth\.resetPasswordForEmail/);
  assert.match(signInScript, /client\.auth\.updateUser/);
  assert.match(signInScript, /window\.location\.replace\(homepageUrl\(\)\)/);
});

test("account database policies isolate profiles and saved products without self-granting access", () => {
  assert.match(accountMigration, /create table public\.user_profiles[\s\S]*?user_id uuid primary key references auth\.users/i);
  assert.match(accountMigration, /create policy "Users read own private profile"[\s\S]*?user_id = \(select auth\.uid\(\)\)/i);
  assert.match(accountMigration, /create policy "Users create own private profile"[\s\S]*?with check \(user_id = \(select auth\.uid\(\)\)\)/i);
  assert.match(accountMigration, /grant insert \(user_id, display_name\) on public\.user_profiles to authenticated/i);
  assert.match(migration, /primary key \(user_id, product_id\)/i);
  assert.match(migration, /create policy "Users manage own saved products" on public\.saved_products for all to authenticated using \(user_id = \(select auth\.uid\(\)\)\) with check \(user_id = \(select auth\.uid\(\)\)\)/i);
  assert.match(migration, /create policy "Users read own entitlements" on public\.entitlements for select/i);
  assert.doesNotMatch(migration, /grant\s+(?:insert|update|delete|all)\s+on\s+public\.entitlements\s+to\s+(?:anon|authenticated)/i);
  assert.match(accountMigration, /public\.can_download_product\(p\.id\)/i);
  assert.match(accountMigration, /revoke all on function public\.list_my_library_products\(\) from public, anon, authenticated/i);
  assert.match(accountMigration, /grant execute on function public\.list_my_library_products\(\) to authenticated/i);
});

test("saved-product actions require a signed-in user and returned rows are owner and publication scoped", () => {
  const userId = "550e8400-e29b-41d4-a716-446655440000";
  const productId = "550e8400-e29b-41d4-a716-446655440001";
  const session = { user: { id: userId } };
  assert.deepEqual(accountCore.savedProductRecord(session, productId), {
    user_id: userId,
    product_id: productId
  });

  test("checkout derives price from published products and fails closed without a verified provider adapter", () => {
    assert.match(checkoutFunction, /auth\.getUser\(userToken\)/);
    assert.match(checkoutFunction, /email_confirmed_at/);
    assert.match(checkoutFunction, /readLimitedBody\(request, 4096\)/);
    assert.match(checkoutFunction, /\.select\("id,title,status,price_minor,currency"\)/);
    assert.match(checkoutFunction, /\.eq\("status", "published"\)/);
    assert.match(checkoutFunction, /\.gt\("price_minor", 0\)/);
    assert.match(checkoutFunction, /create_product_purchase/);
    assert.match(checkoutFunction, /checkoutUrl/);
    assert.match(paymentProvider, /return null/);
    assert.match(checkoutFunction, /Purchases are not enabled/);
    assert.match(checkoutFunction, /isCheckoutUrlAllowed/);
    assert.doesNotMatch(checkoutFunction, /amount_minor:\s*body|currency:\s*body|price:\s*body/i);
    assert.match(commerceMigration, /for update of p/i);
    assert.match(commerceMigration, /Too many recent checkout attempts/i);
    assert.match(commerceMigration, /claim_product_purchase_checkout/);
    assert.match(commerceMigration, /unique index orders_user_request_unique/i);
    assert.match(commerceMigration, /This account already has access to this product/i);
    assert.match(commerceMigration, /o\.status = 'pending'/i);
    const purchaseRpc = commerceMigration.slice(
      commerceMigration.indexOf("create or replace function public.create_product_purchase"),
      commerceMigration.indexOf("create or replace function public.claim_product_purchase_checkout")
    );
    assert.match(purchaseRpc, /p\.price_minor > 0/i);
    assert.doesNotMatch(purchaseRpc, /p\.price_minor = 0/i);
  });

  test("webhook processing is signature-adapter gated, event-idempotent, amount-bound, and entitlement protected", () => {
    assert.match(webhookFunction, /provider\.verifyWebhook\(rawBody, request\.headers, signingSecret\)/);
    assert.match(webhookFunction, /readLimitedBody\(request, 1024 \* 1024\)/);
    assert.match(webhookFunction, /signature or event is invalid/);
    assert.match(webhookFunction, /verified payment adapter returned an invalid event/i);
    assert.match(webhookFunction, /process_verified_product_payment_event/);
    assert.match(paymentProvider, /verifyWebhook\(rawBody: Uint8Array/);
    assert.match(migration, /unique \(provider, provider_event_id\)/i);
    assert.match(commerceMigration, /on conflict \(provider, provider_event_id\) do nothing/i);
    assert.match(commerceMigration, /payment_order\.total_minor <> verified_amount_minor/i);
    assert.match(commerceMigration, /payment_order\.currency <> verified_currency/i);
    assert.match(commerceMigration, /verified_status = 'paid'/i);
    assert.match(commerceMigration, /insert into public\.entitlements \(user_id, product_id, source\)[\s\S]*?'purchase'/i);
    assert.match(commerceMigration, /grant execute on function public\.process_verified_product_payment_event[\s\S]*?to service_role/i);
    assert.doesNotMatch(commerceMigration, /grant execute on function public\.process_verified_product_payment_event[\s\S]*?to authenticated/i);
    assert.match(commerceMigration, /update public\.entitlements\s+set ends_at = now\(\)[\s\S]*?source = 'purchase'/i);
    assert.match(commerceMigration, /verified_status = 'refunded' and refunded_amount_minor <> payment_item\.unit_price_minor/i);
    assert.match(commerceMigration, /verified_status = 'partially_refunded' and refunded_amount_minor >= payment_item\.unit_price_minor/i);
    assert.match(commerceMigration, /verified_status in \('failed', 'cancelled'\)/i);
  });

  test("purchase state and redirect checks require backend verification and HTTPS", () => {
    assert.equal(commerceCore.purchaseState({ status: "paid", verified_at: "2026-01-01T00:00:00Z" }), "verified");
    assert.equal(commerceCore.purchaseState({ status: "paid", verified_at: null }), "pending");
    assert.equal(commerceCore.purchaseState({ status: "pending" }), "pending");
    assert.equal(commerceCore.purchaseState({ status: "refunded" }), "refunded");
    assert.equal(commerceCore.checkoutUrl("https://checkout.example.test/session"), "https://checkout.example.test/session");
    assert.throws(() => commerceCore.checkoutUrl("http://checkout.example.test/session"), /unsafe/);
    assert.throws(() => commerceCore.checkoutUrl("javascript:alert(1)"), /unsafe/);
    assert.match(frontend, /purchaseState\(purchase\)/);
    assert.match(frontend, /Payment verified by BookWell/);
    assert.match(frontend, /waiting for the provider’s verified payment notification/);
    assert.match(frontend, /purchase_history|Purchase history/i);
  });
  assert.equal(accountCore.savedProductMutation(session, productId, false).operation, "insert");
  assert.equal(accountCore.savedProductMutation(session, productId, true).operation, "delete");
  assert.throws(() => accountCore.savedProductRecord(null, productId), /Sign in/);
  assert.throws(() => accountCore.savedProductRecord(session, "invalid"), /product ID/);
  const rows = [
    { user_id: userId, product: { id: productId, status: "published" } },
    { user_id: "550e8400-e29b-41d4-a716-446655440002", product: { id: productId, status: "published" } },
    { user_id: userId, product: { id: productId, status: "draft" } }
  ];
  assert.equal(accountCore.ownPublishedSavedProducts(rows, userId).length, 1);
  assert.equal(accountCore.publishedLibraryProducts([
    { id: productId, status: "published" },
    { id: productId, status: "draft" }
  ]).length, 1);
  assert.match(account, /\.from\("saved_products"\)\.insert/);
  assert.match(account, /\.from\("saved_products"\)\.delete/);
  assert.match(account, /rpc\("list_my_library_products"\)/);
});

test("catalogue query construction preserves filters, selected currency, sorting, and pagination", () => {
  const parameters = marketplaceCore.buildSearchParameters({
    search: "  algebra  ",
    category: "study-resources",
    language: "English",
    priceType: "free",
    fileFormat: "PDF",
    sort: "price_asc",
    currency: "USD",
    minPrice: "0",
    maxPrice: "125.50"
  }, 12, 24);
  assert.deepEqual(parameters, {
    p_search: "algebra",
    p_category: "study-resources",
    p_language: "English",
    p_price_type: "free",
    p_file_format: "PDF",
    p_sort: "price_asc",
    p_limit: 13,
    p_offset: 24,
    p_min_price_minor: 0,
    p_max_price_minor: 12550,
    p_currency: "USD"
  });

  test("marketplace uses USD as the default while accurately formatting other stored currencies", () => {
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    assert.match(html, /<option value="USD" selected>USD \(\$\) · US Dollar<\/option>/);
    assert.match(html, /<option value="USD">USD \(\$\) · US Dollar<\/option>/);
    assert.match(fs.readFileSync(path.join(root, "admin.js"), "utf8"), /const currency = product\?\.currency \|\| "USD"/);
    assert.equal(marketplaceCore.formatPrice(1299, "USD", "en-US"), "$12.99");
    assert.match(marketplaceCore.formatPrice(50000, "INR", "en-IN"), /₹/);
  });

  test("catalogue exposes an explicit search action before clear filters and a positioned search icon", () => {
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const searchButton = html.indexOf('id="catalog-search-button"');
    const clearButton = html.indexOf('id="catalog-clear"');
    assert.notEqual(searchButton, -1);
    assert.ok(searchButton < clearButton);
    assert.match(html, /id="catalog-search-button" class="button" type="submit">Search/);
    assert.match(html, /<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">/);
    assert.match(html, /\.search-control \{ position: relative; display: block; \}/);
    assert.match(html, /\.search-control svg \{[\s\S]*?top: calc\(50% \+ 0\.2rem\)[\s\S]*?transform: translateY\(-50%\)/);
  });

  test("account actions use modern accessible styling and the account section stays white", () => {
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    assert.match(html, /#account\.highlight \{ background: #fff; \}/);
    assert.match(html, /\.account-links button \{[\s\S]*?appearance: none;[\s\S]*?border-radius: 8px/);
    assert.match(html, /\.account-links #account-show-signup \{[\s\S]*?background: var\(--green\);[\s\S]*?color: #fff/);
    assert.match(html, /\.account-links button:focus-visible/);
    assert.match(html, /<section id="volunteer" class="highlight">/);
  });
  assert.throws(() => marketplaceCore.buildSearchParameters({
    search: "", category: "", priceType: "", fileFormat: "", sort: "newest",
    currency: "USD", minPrice: "10", maxPrice: "9"
  }, 12, 0), /Minimum price cannot be greater/);
  assert.throws(() => marketplaceCore.buildSearchParameters({
    search: "", category: "", priceType: "", fileFormat: "", sort: "newest",
    currency: "", minPrice: "1", maxPrice: ""
  }, 12, 0), /Choose a currency/);
  assert.equal(marketplaceCore.buildSearchParameters({
    search: "", category: "", priceType: "", fileFormat: "", sort: "newest",
    currency: "EUR", minPrice: "", maxPrice: ""
  }, 12, 0).p_currency, null);
  assert.equal(marketplaceCore.priceMinor("1250", "JPY"), 1250);
  assert.equal(marketplaceCore.priceMinor("1.234", "KWD"), 1234);
  assert.throws(() => marketplaceCore.priceMinor("1.2", "JPY"), /price between/);
  assert.throws(() => marketplaceCore.priceMinor("2147483.648", "KWD"), /price between/);
});

test("discovery recommendations use explainable listing metadata and related matches", () => {
  const products = [
    {
      id: "550e8400-e29b-41d4-a716-446655440001",
      slug: "recent-science",
      title: "Science primer",
      description: "An introduction to science",
      category_name: "Science",
      language: "English",
      formats: ["PDF"],
      tags: ["biology"],
      created_at: "2026-10-20T00:00:00Z"
    },
    {
      id: "550e8400-e29b-41d4-a716-446655440002",
      slug: "algebra",
      title: "Algebra workbook",
      description: "Practice algebra",
      category_name: "Mathematics",
      language: "English",
      formats: ["PDF"],
      tags: ["algebra"],
      created_at: "2026-10-19T00:00:00Z"
    },
    {
      id: "550e8400-e29b-41d4-a716-446655440003",
      slug: "older-science",
      title: "Science field guide",
      description: "Field notes",
      category_name: "Science",
      language: "French",
      formats: ["EPUB"],
      tags: ["ecology"],
      created_at: "2026-10-01T00:00:00Z"
    }
  ];
  const recommended = marketplaceCore.rankRecommendations(products, {
    categories: ["Science"],
    search: "",
    recentlyViewed: ["recent-science"]
  }, 2);
  assert.deepEqual(recommended.map((product) => product.slug), ["older-science", "algebra"]);
  const related = marketplaceCore.relatedProducts(products, products[1], 4);
  assert.deepEqual(related.map((product) => product.slug), ["recent-science"]);
  assert.deepEqual(marketplaceCore.relatedProducts([], products[0], 4), []);
});

test("smart discovery migration exposes only published metadata and exact listing facets", () => {
  assert.match(discoveryMigration, /p_language text default null/i);
  assert.match(discoveryMigration, /p\.status = 'published'\s+and c\.is_active/i);
  assert.match(discoveryMigration, /p\.created_at end desc/i);
  assert.match(discoveryMigration, /create function public\.browse_public_categories\(\)[\s\S]*?p\.status = 'published'[\s\S]*?count\(p\.id\)/i);
  assert.match(discoveryMigration, /create function public\.browse_public_languages\(\)[\s\S]*?p\.status = 'published'/i);
  assert.match(discoveryMigration, /create function public\.related_public_products[\s\S]*?p\.id <> target_product[\s\S]*?p\.status = 'published'/i);
  assert.match(discoveryMigration, /p\.category_id = a\.category_id[\s\S]*?p\.formats && a\.formats[\s\S]*?exists\s*\([\s\S]*?lower\(product_tag\.tag\) = lower\(anchor_tag\.tag\)/i);
  assert.doesNotMatch(discoveryMigration, /file_path/);
  assert.match(discoveryMigration, /security definer\s+set search_path = ''/i);
});

test("smart discovery sections remain clear without a catalog connection and avoid nested section spacing", () => {
  const marketplace = fs.readFileSync(path.join(root, "marketplace.js"), "utf8");
  assert.match(index, /id="discover" aria-labelledby="discover-title"/);
  assert.match(index, /id="catalog-language" name="language"/);
  assert.match(index, /\.discovery-grid > section \{ min-width: 0; margin: 0; padding: 0; \}/);
  assert.match(index, /#product-related \{ max-width: none; margin: 1\.5rem 0 0; padding: 1rem 0 0;/);
  assert.match(marketplace, /Recommendations will appear when published resources are available/);
  assert.match(marketplace, /Recently added resources will appear when the public catalog is connected/);
  assert.match(marketplace, /renderActiveFilters\(\);\s*loadProducts\(false\);/);
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

test("stored currencies format through Intl without assuming one marketplace currency", () => {
  assert.equal(marketplaceCore.formatPrice(1299, "USD", "en-US"), "$12.99");
  assert.match(marketplaceCore.formatPrice(50000, "INR", "en-IN"), /500/);
  assert.match(marketplaceCore.formatPrice(1299, "EUR", "de-DE"), /12,99/);
  assert.equal(marketplaceCore.formatPrice(0, "GBP", "en-GB"), "Free");
  assert.equal(marketplaceCore.formatPrice(1299, "JPY", "ja-JP"), "￥1,299");
  assert.match(marketplaceCore.formatPrice(1234, "KWD", "en-KW"), /1[.,]234/);
  assert.equal(marketplaceCore.amountFromMinor(1234, "KWD"), 1.234);
  assert.throws(() => marketplaceCore.formatPrice(100, "US", "en-US"), /invalid/);
});

test("product form validation supports published paid listings without enabling fake checkout", () => {
  const fields = {
    title: "  Algebra Notes ",
    slug: "algebra-notes",
    description: "Concise revision notes for algebra.",
    language: "English",
    license: "CC BY 4.0",
    tags: "math, algebra",
    formats: ["PDF", "INVALID"],
    price: "0",
    currency: "INR",
    status: "draft"
  };
  const normalized = adminCore.validateProductFields(fields);
  assert.equal(normalized.title, "Algebra Notes");
  assert.equal(normalized.language, "English");
  assert.equal(normalized.status, "draft");
  assert.deepEqual(normalized.tags, ["math", "algebra"]);
  assert.deepEqual(normalized.formats, ["PDF"]);
  assert.equal(normalized.price_minor, 0);
  assert.equal(normalized.currency, "INR");
  assert.equal(adminCore.validateProductFields({
    ...fields, price: "10.00", status: "published"
  }).price_minor, 1000);
  assert.throws(() => adminCore.validateProductFields({ ...fields, price: "10.001" }), /too many decimal places/);
  assert.throws(() => adminCore.validateProductFields({ ...fields, slug: "../bad" }), /slug/);
  assert.throws(() => adminCore.validateProductFields({ ...fields, language: "" }), /language/);
  assert.equal(adminCore.validateProductFields({
    ...fields, currency: "JPY", price: "1250"
  }).price_minor, 1250);
  assert.equal(adminCore.validateProductFields({
    ...fields, currency: "KWD", price: "1.234"
  }).price_minor, 1234);
  assert.throws(() => adminCore.validateProductFields({
    ...fields, currency: "JPY", price: "1.2"
  }), /too many decimal places/);
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
  const permissionCheck = downloadFunction.indexOf('"can_download_product"');
  const privatePathLookup = downloadFunction.indexOf('"get_authorized_download_path"');
  assert.notEqual(permissionCheck, -1);
  assert.notEqual(privatePathLookup, -1);
  assert.ok(permissionCheck < privatePathLookup);
  assert.match(downloadFunction, /serviceClient\.rpc\(\s*"get_authorized_download_path"/);
  assert.match(downloadFunction, /if \(pathError \|\| typeof filePath !== "string" \|\| filePath\.length === 0\)/);
  assert.match(downloadFunction, /createSignedUrl\(filePath, 60\)/);
  assert.match(downloadFunction, /extension: extension/);
  assert.match(downloadFunction, /console\.error\("Storage could not issue an authorized download\."\)/);
  assert.doesNotMatch(downloadFunction, /console\.(?:log|error)\([^)]*signedUrl/i);
  assert.match(commerceMigration, /revoke all on function public\.get_authorized_download_path\(uuid, uuid\) from public, anon, authenticated/i);
  assert.match(commerceMigration, /grant execute on function public\.get_authorized_download_path\(uuid, uuid\) to service_role/i);
  assert.match(commerceMigration, /public\.user_can_download_product\(target_product, \(select auth\.uid\(\)\)\)/i);
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

test("homepage search and category shortcuts use the existing catalogue filters", () => {
  const marketplace = fs.readFileSync(path.join(root, "marketplace.js"), "utf8");
  assert.match(index, /id="hero-search-form"/);
  assert.match(index, /id="hero-search"/);
  assert.match(index, /id="catalog-search"/);
  assert.match(index, /id="catalog-category-links"/);
  assert.match(marketplace, /elements\.search\.value = elements\.heroSearch\.value\.trim\(\)/);
  assert.match(marketplace, /elements\.category\.value = button\.dataset\.categorySlug/);
  assert.match(marketplace, /categories\.forEach\(function \(category\)/);
});

test("responsive navigation and accessible reduced-motion styles are present", () => {
  assert.match(index, /id="nav-menu-toggle"[^>]*aria-controls="primary-nav" aria-expanded="false"/);
  assert.match(index, /primaryNavContainer\.classList\.toggle\('nav-open', !isExpanded\)/);
  assert.match(index, /@media \(max-width: 900px\)/);
  assert.match(index, /@media \(max-width: 350px\)/);
  assert.match(index, /@media \(prefers-reduced-motion: reduce\)/);
});

test("marketplace presentation uses editorial tokens and real creator attribution", () => {
  const marketplace = fs.readFileSync(path.join(root, "marketplace.js"), "utf8");
  assert.match(index, /--page:\s*#faf9f6/i);
  assert.match(index, /--text:\s*#191919/i);
  assert.match(index, /--green:\s*#245b45/i);
  assert.match(index, /--font-editorial:\s*Georgia/);
  assert.match(index, /object-fit:\s*contain/);
  assert.match(marketplace, /typeof product\.creator_name === "string" && product\.creator_name\.trim\(\)/);
  assert.match(marketplace, /addText\(card, "p", money\(product\), "product-price"\)/);
  assert.match(marketplace, /addText\(elements\.dialogContent, "p", "Price: " \+ money\(product\), "product-detail-price"\)/);
});

test("homepage hero uses the supplied artwork and database-backed subject links", () => {
  const marketplace = fs.readFileSync(path.join(root, "marketplace.js"), "utf8");
  assert.match(index, /class="hero-highlight">learning<\/span>/);
  assert.match(index, /src="bookwell-hero-art\.png"/);
  assert.match(index, /class="hero-illustration"/);
  assert.match(index, /id="account-nav" class="nav-signin">Sign In/);
  assert.match(index, /id="featured-category-links"/);
  assert.match(index, /id="featured-empty-state"/);
  assert.match(marketplace, /featuredButton\.textContent|featuredButton\.append\(categoryName, action\)/);
  assert.match(marketplace, /featuredCategoryLinks\.addEventListener\("click", selectCategory\)/);
  assert.match(marketplace, /window\.location\.hash = "#library";\s+loadProducts\(false\);/);
  assert.doesNotMatch(index, /hero-logo-card|hero-art-orb/);
});
