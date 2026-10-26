# BookWell

BookWell is a volunteer-run learning-resource site. The public website keeps its original single-page design and adds a catalog interface backed by a Supabase project when configured. It does not include sample products, fake reviews, payment simulations, or production credentials.

## Current implementation

- Original BookWell logo assets, green-and-white colors, Georgia typography, navigation, mission, volunteer information, contact details, and Google Translate UI are preserved.
- Once Supabase is configured, the library supports server-side catalog search, category, free/paid, file-format, selected-currency price-range filters, sorting, pagination, product details, and empty/loading/error/retry states. Prices format from each product's stored ISO currency using `Intl.NumberFormat`; no exchange rates or conversions are used. Price sorts group by currency rather than comparing unlike amounts.
- Only published products are returned by database search functions. The commerce migration allows published paid listings to appear in the catalogue/detail pages, but product file paths remain excluded from public SQL reads.
- Published paid products can be displayed with their stored ISO currency and a Buy action. Checkout is intentionally fail-closed: no provider adapter or merchant credentials are configured, so the endpoint refuses purchases and does not create a payment success or entitlement.
- The unapplied commerce migration verifies provider-reported totals against immutable order items, deduplicates provider events, grants purchase entitlements only after verified success, and expires purchase entitlements on partial or full refunds. Any refund status removes download eligibility under the current order rule.
- Free and paid filters, price ranges, sorting, pagination and product details remain server-side. Price ranges still require one selected currency; prices are never converted.
- The existing `currency` and `price_minor` columns support ISO currency-specific minor units without a schema migration: the admin currently offers USD, INR, EUR, GBP, AUD, JPY, and KWD. Amounts are converted using each currency's ISO minor-unit precision (including zero-decimal JPY and three-decimal KWD), and displayed with `Intl.NumberFormat`. Because `price_minor` is a signed 32-bit integer, accepted prices are capped to its representable range for the selected currency. Price filters require a selected currency and compare only values in that currency; no exchange rates or conversions are used.
- USD (`$`) is now the default for marketplace price-range selection and newly created product drafts. Existing listings continue to display their actual stored currency; no foreign-currency amount is relabeled as dollars or converted without an exchange rate.
- The download flow checks the user's authorization through a Supabase Edge Function, then uses the server-only service role to retrieve the private file path and issue a 60-second signed URL. It is unavailable until Supabase is configured and deployed. The commerce migration removes direct client execution of the private-path RPC and preserves the shared published/free-or-entitled access rule.
- The migration lays groundwork for roles, creator listings, orders, idempotent payment events, subscription plans and entitlements, saved products, collections, eligible reviews, reports, authorized-download-link history, payout ledgers, payouts, and audit logs. A logged link issuance does not prove that the file transfer completed.
- Administrator sign-in, product CRUD, upload validation, and a local unsaved-listing preview are implemented in the static UI. Supabase Auth and the migration must be configured first. The access token is held in memory only, so an administrator must sign in again after a page reload.
- Creator Studio reuses the administrator product-management backend for overview, product status filters, draft creation/editing, duplication, publication/archive, previews, private uploads, and recorded analytics. It remains administrator-only: the existing creator role can submit drafts, but does not have the complete owner-scoped Storage and publication permissions required for a secure creator dashboard.
- The commerce migration adds an optional product `language` field without fabricating values for existing listings, and returns it through public listing/detail and admin product RPCs. Product type reuses the existing supported `formats` array; covers reuse the existing private preview-image bucket.
- Creator Studio analytics count exact stored product states, download-link issuance events (not completed downloads), and paid orders with a verification timestamp. Product page views and revenue are not currently tracked.
- The account area now uses the pinned Supabase JavaScript v2 client for email/password sign-up and sign-in, confirmation/resend, password recovery, persistent PKCE sessions, sign-out, private display-name settings, saved products, and a personal library. The Library remains public to browse.
- Saved-product relationships and private profiles are scoped to the authenticated user by RLS. The personal library is returned by an authenticated database function that calls the existing `can_download_product` authorization rule. Paid access is still not purchasable; only legitimate free access and any existing server-managed entitlement/order records can authorize downloads.
- The new `20261025204000_user_accounts.sql` migration adds a minimal private `user_profiles` table, its RLS/grants, a user-scoped recent-download index, and `list_my_library_products()`. It reuses the existing `saved_products`, `entitlements`, and download authorization schema. It has not been applied to any Supabase project.
- Supabase sessions are persisted and refreshed by the Supabase JS client in browser storage. This is standard for the client SDK; use HTTPS, the public anon key only, configure trusted redirect URLs, and never store passwords in BookWell code.
- Product previews are in a private Storage bucket. Anonymous users can create a five-minute signed preview URL only when the database row and Storage RLS confirm that the product is published, free, and in an active category. Draft/unpublished previews are not readable through public object URLs or signed-URL requests.
- Administrator file uploads perform size, extension, and signature checks in the browser; Supabase Storage also enforces bucket MIME metadata and size limits. This does not provide antivirus scanning or comprehensive archive/document validation.
- No provider-specific checkout adapter, live or sandbox payment integration, subscription activation, creator self-service upload workflow, upload malware scanner, or payout workflow is implemented. No payment credentials have been added.

## Phase 2 plan and implementation boundaries

| Stage | Scope |
| --- | --- |
| Foundation delivered (code only) | Supabase Postgres schema with RLS; private product files/previews; public catalog and entitlement-checked download groundwork; accounts, saved products and private profiles; provider-neutral purchase/order and verified-event foundation; paid product listing; fail-closed checkout/webhook function boundaries. |
| Needs project setup | Create a disposable Supabase project, review/apply all three migrations, configure Auth verification/redirects, deploy reviewed Edge Functions, enter only the public URL/anon key in `supabase-config.js`, bootstrap an administrator, then test with separate accounts. No provider has been selected or integrated. |
| Blocked on merchant decision | Confirm seller country, payout country/bank and a legally eligible adult/business account owner; select a provider and complete its onboarding; implement and sandbox-test its checkout and signed webhook adapter before enabling purchases. |
| Future separate milestones | Creator self-service roles and Storage policies, moderation workflows, subscriptions, upload malware scanning and payout operations. |

The current GitHub Pages site has no server-side runtime. Supabase is the selected additive backend assumption because it provides Postgres, Auth, private Storage, row-level security, and Edge Functions without replacing the static frontend. Free-tier availability and limits can change; review current Supabase terms and usage before launch. This is not a promise that production storage, bandwidth, domains, or payment processing will remain free.

## Supabase setup

1. Create a **disposable test project** separate from any production project. Review its region, pricing, privacy terms, and free-tier limits. Use no production users, data, keys, or buckets for the first test.
2. Review all three migrations before applying them. `20261025185600_marketplace_foundation.sql` creates the initial marketplace schema and private storage buckets for a new BookWell Supabase project. `20261025204000_user_accounts.sql` adds private user profiles and the authenticated library RPC. `20261025205700_commerce_foundation.sql` adds purchase processing foundations and closes public product-file-path reads. None has been applied to a Supabase project. Do not use the first-install foundation as a production upgrade without a reviewed backup and explicit approval. If a bucket with either BookWell bucket ID already exists with different visibility, size, or MIME rules, the foundation migration aborts instead of changing the existing bucket.

   In Supabase CLI, verify the disposable project reference in the dashboard before linking it. Review the pending migration list/diff. Stop before `supabase db push` unless the project owner has explicitly approved applying the reviewed migration to this disposable project:

   ```powershell
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase migration list
   supabase db push --dry-run
   # Run only after explicit approval for this disposable project:
   supabase db push
   ```

   The migrations are `supabase/migrations/20261025185600_marketplace_foundation.sql`, `supabase/migrations/20261025204000_user_accounts.sql`, then `supabase/migrations/20261025205700_commerce_foundation.sql`. They are not a universal upgrade for an existing Supabase schema. If a BookWell database already exists, inspect its schema and data and write separate compatible migrations; do not reset it or rerun the first-install migration. SQL parsing and `--dry-run` are not substitutes for testing RLS against live PostgREST/Storage requests.
3. Deploy the secure download function to the disposable project only after the project owner explicitly approves deployment to that test project:

   ```powershell
   # Run only after explicit approval for this disposable project:
   supabase functions deploy create-download
   ```

   The managed Edge Function runtime supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Confirm that the required names exist in the project’s function settings without printing their values. Keep the service-role key server-side only. Never place it in `index.html`, `marketplace.js`, `admin.js`, `supabase-config.js`, or any public GitHub variable/file. Do not add manual secrets unless the chosen runtime explicitly requires them.
4. The new `create-checkout` and `payment-webhook` functions are provider-neutral boundaries only. The checked-in provider resolver intentionally has no adapter, so checkout returns unavailable and the webhook refuses to process events. Do not deploy them expecting working payments. After merchant country/adult account eligibility and a concrete provider adapter have been reviewed, deploy them only to the disposable project with explicit approval. Keep gateway JWT verification enabled for `create-checkout`; the external webhook has `verify_jwt = false` and must verify the provider's signature against the raw body before its service-role-only database RPC is called.
5. Set `supabase-config.js` to the project URL and **public anon key**:

   ```js
   window.BOOKWELL_CONFIG = {
     supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
     supabaseAnonKey: "YOUR_PUBLIC_ANON_KEY"
   };
   ```

   The anon key is designed to be public; authorization relies on database RLS and server-side checks, not secrecy of that key. Never use the service-role key here.
6. In Supabase Auth settings for the disposable project, enable email/password sign-up, require email confirmation, set the site URL to `https://www.bookwell.dpdns.org`, and allow the exact confirmation/recovery redirect `https://www.bookwell.dpdns.org/#account` (plus the local test URL you use). Review email-provider limits and password requirements; free-tier email delivery may be rate-limited. Public sign-up creates ordinary accounts only and never assigns a role. Create a separate intended administrator through the Dashboard/invite flow, verify the intended user's UUID in Auth, then assign the initial admin role using the privileged SQL Editor:

   ```sql
   insert into public.user_roles (user_id, role)
   values ('REPLACE_WITH_VERIFIED_AUTH_USER_UUID', 'admin')
   on conflict (user_id) do update set role = excluded.role;
   ```

   Run this only for a verified, intended administrator. Normal browser users have no insert/update/delete grant on `user_roles`; never add self-service role assignment or trust browser-provided roles. Never disable email verification for a real user rollout.
7. Put only the test project's public URL and anon key in the local `supabase-config.js`. The static page loads the pinned Supabase JS 2.57.4 UMD client from jsDelivr; account access also needs that script host reachable. Sign up with an ordinary test address, confirm email, sign in, save/unsave a published resource, update the optional display name, request and complete a password reset, and sign out/in again to verify the persistent session. Test an unverified address and check that the interface offers a resend action. The user's profile and saved rows must be visible only to that user's authenticated session.
8. Open `#admin`, sign in with the separately provisioned administrator, and create test listings. The browser calls PostgREST/Storage with the user access token; database RLS and Storage policies require the admin role for privileged writes. The dashboard supports metadata, category, tags/formats, price amount and selected currency, status, product-file upload, preview-image upload, edits, unpublishing by status change, and deletion of products without order history.
9. `product-files` and `product-previews` must both be private buckets. The foundation migration checks those settings and aborts on mismatched existing bucket configuration. Product files use a random filename under the product UUID folder. Preview image signing is allowed only for an admin or a published product in an active category; preview URLs expire after five minutes. Public catalogue/detail RPCs return published products and prices, but never product-file paths. Paid file access still requires a valid paid order or entitlement.
10. Upload checks compare file signatures, extensions, size, and allowlisted MIME metadata. These checks are not malware scanning and do not fully validate OOXML/ZIP contents. Review/licence files before publishing. Do not upload untrusted files until a server-side malware scanning process is added.
11. Deletion is blocked when order items refer to the listing; archive/unpublish it instead. If Storage cleanup fails after a metadata change/deletion, the dashboard reports that an orphaned object may need manual cleanup.
12. Review and apply `20261025204000_user_accounts.sql` after the marketplace foundation. Review and apply `20261025205700_commerce_foundation.sql` after both earlier migrations. The commerce migration changes product reads to column-level grants (public direct table requests cannot read private `file_path`), adds admin-only listing access, allows paid products to be published, and adds purchase/idempotency/webhook functions. It does not install a payment provider or enable live checkout.

The domain allowlist in the download function contains `https://www.bookwell.dpdns.org` and local `localhost`/`127.0.0.1` development origins. Update that list deliberately if the domain changes.

## Local development

This repository has no Node build or dependency installation. Serve the static site from the repository root:

```powershell
python -m http.server 8000
```

Open `http://localhost:8000`. Without a configured Supabase project, the website preserves its public content and displays a clear catalogue setup state; the admin interface remains disabled and the catalogue does not show invented products.

For a local Supabase CLI project, use its local API URL (typically `http://127.0.0.1:54321`) and local anon key in `supabase-config.js`. Browser configuration accepts only an HTTPS `*.supabase.co` project URL or the local loopback API on port `54321`; it rejects arbitrary HTTP hosts.

For local Edge Function development, install the Supabase CLI and Docker, then follow Supabase's local development instructions. Email/password accounts are implemented in the frontend but still require a real configured Supabase project. The checkout and webhook function boundaries remain disabled until a provider adapter and eligible merchant account are configured. Do not test paid access by editing browser storage.

## Deployment

- Keep the existing GitHub Pages deployment and `CNAME` (`www.bookwell.dpdns.org`).
- Commit only the public Supabase URL/anon key configuration if desired; never commit server secrets.
- Deploy the SQL migration and Edge Function to Supabase separately from GitHub Pages.
- Verify the public catalog, RLS denial for drafts/private product data, signed URL expiry, unauthorized paid-download denial, and domain CORS behavior before publishing.
- Account sections are part of the existing single-page site and contain no private database records until Auth succeeds. Confirm that account queries expose only the authenticated user's rows; never rely on hiding the account section as access control.

## Disposable Supabase integration checklist

Complete this checklist only against the disposable test project. The migration and current Edge Function have not been applied/deployed; the checks below are required before any production launch.

### Configuration and secrets

| Name | Location | Classification / handling |
| --- | --- | --- |
| `supabaseUrl` | `supabase-config.js` | Public project URL; commit only when intentionally connecting this site to that project. |
| `supabaseAnonKey` | `supabase-config.js` | Public/anon key; safe to expose only because RLS is enabled and verified. |
| `SUPABASE_URL` | Managed Edge Function runtime | Project URL; non-secret. |
| `SUPABASE_ANON_KEY` | Managed Edge Function runtime | Public/anon key; non-secret. |
| `SUPABASE_SERVICE_ROLE_KEY` | Managed Edge Function runtime only | Secret; bypasses RLS. Never expose, log, commit, or put in browser configuration. |

Keep local environment files in `.env` or another ignored secret file. Do not paste secret values into terminal transcripts, issue comments, screenshots, or documentation. Supabase-managed Edge Function defaults should be used when available; do not copy service-role values into project source.

### Project, migration, buckets, and function

1. Create a disposable Supabase project with a distinct name and ref; verify both before running CLI commands. Use no production data. Record only its project ref, not credentials, in local test notes.
2. Review all three ordered migrations: the marketplace foundation, `20261025204000_user_accounts.sql`, and `20261025205700_commerce_foundation.sql`. Pay particular attention to grants, `SECURITY DEFINER` functions, role policies, purchase transitions, and Storage policies. Confirm no unexpected migration is included. Link the CLI only to the disposable ref, inspect `supabase migration list`, run `supabase db push --dry-run`, and apply only after reviewing the SQL and explicitly approving that disposable-project change.
3. In Storage, verify `product-files` is **private**, limited to 50 MiB and the migration’s document MIME allowlist; verify `product-previews` is **private**, limited to 2 MiB and PNG/JPEG/WebP. Do not make either bucket public. Confirm the deployed policies let admins write, let users read only allowed product files, and let non-admins sign/read preview objects only for published free listings in active categories.
4. Deploy `create-download` to the disposable project using `supabase functions deploy create-download`. In function settings, confirm the expected `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and server-only `SUPABASE_SERVICE_ROLE_KEY` names are available. Keep `verify_jwt = true`. Test permitted production and localhost origins; reject an unrelated origin. Do not print or export secret values.
5. Set only the test project's URL and public anon key in the local `supabase-config.js`. Confirm the service-role key is absent from all browser-delivered files and Git history.

### Admin bootstrap and role tests

1. Enable email/password user sign-up with email confirmation in the disposable Auth project. Create two ordinary test identities through the BookWell account flow, one intended admin through the Dashboard/invite flow, and one anonymous visitor with no session. Public sign-up must create ordinary accounts only; no user role may be self-assigned.
2. Verify the admin Auth UUID from the Dashboard before running the one-time `user_roles` insert shown above in the privileged SQL Editor. Never run role assignment from browser code or as a normal user. Confirm the ordinary user cannot insert/update/delete `user_roles` and cannot make `has_role('admin')` true, even by submitting an `admin` value.
3. As admin, create/edit a draft, upload a valid test document and image, publish a free listing, unpublish it, and delete a disposable listing with no dependent records. Confirm each operation and its Storage effects through the dashboard/API and database.
4. As the ordinary user, attempt direct PostgREST insert/update/delete against another user's product and direct Storage upload/replace/delete into both buckets. Every administrative write must be denied. Attempt product reads for another user's draft and confirm no row is returned.
5. As anonymous, call the public catalogue/detail RPCs for published free and paid listings and for a draft/unpublished listing. Only published active-category product metadata should be returned; draft rows, private file paths, and paid preview paths must remain unavailable. Try direct database reads for draft rows and `products.file_path` and confirm they are denied/filtered.
6. For previews, confirm a published free product can obtain a short-lived signed preview URL, while a draft, archived, rejected, inactive-category, or otherwise unpublished product cannot. Try the legacy `/storage/v1/object/public/...` URL and verify it fails because the bucket is private. After unpublishing, verify a newly requested URL is denied; remember any previously issued signed URL remains usable until its five-minute expiry.
7. For files, confirm an anonymous user can download only an authorized published free file through `create-download`, and that an ordinary user can download paid files only with verified access. Confirm draft/unpublished files are denied through `create-download` and direct Storage requests. After the commerce migration, a paid listing may be published and displayed, but it must remain inaccessible without verified payment or another valid entitlement. Do not simulate checkout or create payment entitlements.
8. Repeat the denial checks with no `Authorization` header and with an invalid/expired user token. Inspect Edge Function logs for generic errors only; confirm no tokens, file contents, or secrets are logged.

### Account, personal-library, and commerce tests

1. In separate browser profiles, create two ordinary test accounts and verify both email addresses. Sign in/out, reload to verify the Supabase client session restores, and confirm each account sees only its own display name and saved products.
2. Save a published free listing as user A, then verify it appears for A but not user B or anonymous visitors. Unsave it and confirm it disappears for A. Try direct PostgREST insert/delete using user B's UUID and confirm RLS denies cross-user access.
3. Attempt direct insert/update/delete against `entitlements`, `orders`, and `user_roles` using each ordinary account; all must be denied. Do not seed paid entitlements or simulate purchases.
4. Call `list_my_library_products()` with an authenticated user and anonymously. Only authenticated users may execute it; the response must contain only published resources for which `can_download_product(product_id)` succeeds under that user's Auth context. Verify an unpublished listing is absent.
5. Download a published free file as anonymous and as an ordinary user through `create-download`. Confirm a private draft is denied. A published paid listing may appear in the catalogue, but remains inaccessible unless the account has verified purchase access; do not create a paid entitlement during these tests.
6. Request password recovery, follow the redirect, set a new password, and sign in with it. Test an invalid/expired recovery link and an unverified signup. Do not log access/refresh tokens or signed URLs.
7. Before adding any provider adapter, verify an authenticated checkout call fails closed, that a browser cannot set amount/currency, and that no pending order is created when no adapter is configured. Test product status and price derivation directly through the authenticated RPC.
8. After a provider is selected, use its sandbox—not a mocked browser redirect—to test successful, failed, cancelled, duplicated, forged-signature, and refunded events. Confirm only a valid signed event updates the order and grants/revokes access; replay each event ID and verify idempotency. Confirm that visiting the success URL alone never grants access.
9. Check public direct PostgREST selection of `products.file_path` is denied, while the admin-only product listing RPC returns it only to an administrator.

### Safe reset

- Use only disposable test records and synthetic files.
- To reset local Supabase, verify no hosted project is linked for the command and use the local CLI's `supabase db reset` only against the local container.
- To discard a disposable hosted test environment, verify its project name/ref in the Dashboard, export only non-sensitive test results if needed, then delete that disposable project in the Dashboard. Do not run reset/drop/truncate commands against production or an unverified linked ref.
- Revoke test Auth identities and any copied test credentials. Never reuse test credentials in production.

Passing these checks verifies only that disposable environment and the tested project configuration; it does not itself authorize production migration, deployment, or launch.

## Environment variables

| Name | Where used | Secret? |
| --- | --- | --- |
| `supabaseUrl` | `supabase-config.js`, browser catalog | No |
| `supabaseAnonKey` | `supabase-config.js`, browser catalog | No; public key, protected by RLS |
| `SUPABASE_URL` | Supabase Edge Function runtime | No |
| `SUPABASE_ANON_KEY` | Supabase Edge Function runtime | No |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Edge Function runtime only, to retrieve authorized private paths, issue signed URLs, and record download events | **Yes; server-only** |
| `PAYMENT_PROVIDER` | Future payment adapter selection in Edge Functions | No; do not set until an adapter is selected |
| `PAYMENT_API_KEY` | Future provider-specific checkout adapter | **Yes; server-only** |
| `PAYMENT_WEBHOOK_SECRET` | Future payment webhook signature verifier | **Yes; server-only** |

No payment provider is selected or connected. Do not take live payments until a suitable provider for the business/geography is selected and its server-side checkout, signed webhook verification, idempotency, refunds, and entitlement updates are implemented and tested.

The provider-neutral Edge Function boundaries accept future server-only variables `PAYMENT_PROVIDER`, `PAYMENT_API_KEY` (or provider-specific credentials), and `PAYMENT_WEBHOOK_SECRET`. The current provider registry intentionally returns no adapter. Do not set arbitrary values or deploy these endpoints expecting checkout to work; they return a safe unavailable response. Keep every payment secret and `SUPABASE_SERVICE_ROLE_KEY` in the Supabase Edge Function environment only.

### Payment provider decision (research checked 25 October 2026)

The seller's country, business registration and payout-bank country are unknown, so no provider is selected and no merchant eligibility is claimed.

| Provider | Fit and currencies | Age / merchant eligibility | Cost notes |
| --- | --- | --- | --- |
| Stripe Checkout | Hosted one-time checkout; supports charges in 135+ currencies including USD, INR, EUR, GBP, CAD and AUD. Charge and settlement currencies differ; account availability and payout rules depend on seller country. Stripe is a processor, not a merchant of record. | Stripe's published agreement describes a route for a minor (minimum account age 13) only with an adult Representative who accepts responsibility, subject to the local agreement and onboarding. A parent/guardian or eligible business owner may need to be the actual representative. | Standard pricing is country-specific; Stripe lists no setup or monthly fees on standard pricing. Processing fees cannot be estimated without country/payment method. Seller remains responsible for tax/merchant obligations. |
| PayPal Checkout | Country-dependent seller support; USD/EUR/GBP/CAD/AUD and other currencies are listed, but INR is not in the official supported-currency reference reviewed. Seller eligibility and payout currency need country-specific confirmation. Not a merchant of record. | Local terms control; assume an adult account holder or eligible business representative is required unless the seller's local agreement explicitly permits otherwise. | Merchant fees depend on seller country, payment type and currency; no reliable estimate without location. |
| Paddle | Hosted checkout and merchant-of-record services; supports buyers in 200+ countries and payments in 30+ currencies including INR, USD, EUR, GBP, CAD and AUD. Seller-country onboarding and payout availability still need confirmation. | Public seller terms reviewed did not establish a minor exception; plan on an adult/eligible entity representative unless Paddle confirms otherwise for the seller's jurisdiction. | Published Paddle Checkout fee is 5% + US$0.50 per transaction (confirm current terms and applicability). |
| Lemon Squeezy | Hosted checkout and merchant of record; seller-country availability must be checked. The official currency list and INR checkout/payout availability were not conclusively verified in this research. | Public terms reviewed did not establish a minor exception; obtain explicit eligibility confirmation for the adult/business account owner. | Fees and add-ons require confirmation from the current pricing page; not used for an estimate here. |

**Suggested evaluation, not a selection:** if the seller's country and an adult Representative qualify, Stripe is a candidate for broad checkout currency support, but it leaves tax/compliance responsibilities with the seller. If merchant-of-record tax handling is preferred, evaluate Paddle after confirming seller-country onboarding, payout currency and the adult/legal account route. The account must belong to the genuine eligible adult or business; never misstate age or borrow an identity. No payment provider costs are incurred by this code as currently configured.

Sources (official provider pages, checked 25 October 2026): [Stripe country availability](https://stripe.com/global), [Stripe agreement](https://stripe.com/legal/ssa), [Stripe currencies](https://docs.stripe.com/currencies), [Stripe pricing](https://stripe.com/pricing), [Stripe webhook verification](https://docs.stripe.com/webhooks/signature); [PayPal country availability](https://www.paypal.com/webapps/mpp/country-worldwide), [PayPal user agreement](https://www.paypal.com/us/legalhub/paypal/useragreement-full), [PayPal currencies](https://developer.paypal.com/reports/reference/supported-currencies), [PayPal fees](https://www.paypal.com/us/business/paypal-business-fees), [PayPal webhook verification](https://developer.paypal.com/api/webhooks/v1/); [Paddle supported countries](https://developer.paddle.com/concepts/sell/supported-countries-locales/), [Paddle currencies](https://developer.paddle.com/concepts/sell/supported-currencies.md), [Paddle terms/pricing](https://www.paddle.com/legal/terms), [Paddle webhook verification](https://developer.paddle.com/webhooks/about/signature-verification.md); [Lemon Squeezy country eligibility](https://docs.lemonsqueezy.com/help/getting-started/supported-countries), [fees](https://docs.lemonsqueezy.com/help/getting-started/fees), [terms](https://www.lemonsqueezy.com/terms), [webhook signing](https://docs.lemonsqueezy.com/help/webhooks/signing-requests).

## Validation

There is no production build or pre-existing test framework. Run the dependency-free frontend logic/security regression tests and syntax checks with:

```powershell
node --test tests/security-foundation.test.js
node --check account-client.js
node --check account-core.js
node --check account.js
node --check marketplace.js
node --check marketplace-core.js
node --check admin.js
node --check admin-core.js
node --check commerce-core.js
git diff --check
```

These tests exercise pure catalogue-query construction, currency formatting, account/save and purchase-state helpers, product metadata/file validation, and static migration/function invariants. They do not execute SQL, exercise PostgreSQL RLS, or call real Supabase Auth/Storage/Edge Functions/provider sandboxes. Those must additionally be tested against a disposable project with anonymous, two ordinary users, and an administrator; the chosen payment provider's sandbox must verify checkout and webhook behavior before production setup. This repository does not claim that a payment integration, subscription, upload scanner, or live deployment has been tested.
