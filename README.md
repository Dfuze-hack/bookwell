# BookWell

BookWell is a volunteer-run learning-resource site. The public website keeps its original single-page design and adds a catalog interface backed by a Supabase project when configured. It does not include sample products, fake reviews, payment simulations, or production credentials.

## Current implementation

- Original BookWell logo assets, green-and-white colors, Georgia typography, navigation, mission, volunteer information, contact details, and Google Translate UI are preserved.
- Once Supabase is configured, the library supports server-side catalog search, category, free/paid, file-format, and INR price-range filters, sorting, pagination, product details, and empty/loading/error/retry states. Price sorts group products by currency rather than comparing unlike minor-unit amounts.
- Only published products are returned by database search functions. Product data is not downloaded into the browser for local filtering.
- Paid products are deliberately excluded from public listing/detail queries until a real checkout and verified payment flow is implemented. A price filter is not a payment mechanism.
- The catalogue retains the paid-price filter for schema readiness but reports that paid products are unavailable; only free published products are exposed until payments exist.
- The download flow requests server-side authorization through a Supabase Edge Function and private Storage, fetches the 60-second signed URL, and renews it once if Storage reports an expired/unauthorized link. It is unavailable until Supabase is configured and deployed. The database migration enforces published status and download entitlements once applied.
- The migration lays groundwork for roles, creator listings, orders, idempotent payment events, subscription plans and entitlements, saved products, collections, eligible reviews, reports, authorized-download-link history, payout ledgers, payouts, and audit logs. A logged link issuance does not prove that the file transfer completed.
- Administrator sign-in, product CRUD, upload validation, and a local unsaved-listing preview are implemented in the static UI. Supabase Auth and the migration must be configured first. The access token is held in memory only, so an administrator must sign in again after a page reload.
- Product previews are in a private Storage bucket. Anonymous users can create a five-minute signed preview URL only when the database row and Storage RLS confirm that the product is published, free, and in an active category. Draft/unpublished previews are not readable through public object URLs or signed-URL requests.
- Administrator file uploads perform size, extension, and signature checks in the browser; Supabase Storage also enforces bucket MIME metadata and size limits. This does not provide antivirus scanning or comprehensive archive/document validation.
- No payment provider, checkout, subscription activation, user account library, creator dashboard, upload malware scanner, or payout workflow is implemented. Paid listings cannot be published and are not returned to public catalogue/detail RPCs.

## Phase 2 plan and implementation boundaries

| Stage | Scope |
| --- | --- |
| Foundation delivered | Supabase Postgres schema with row-level security; private product-file and preview buckets; preview reads checked against published/free product state; free-only public catalogue RPCs; access-checked download RPC and Edge Function; administrator sign-in and product CRUD UI. |
| Needs project setup | Create a Supabase project, review/apply the migration, deploy the Edge Function, enter public URL/anon key in `supabase-config.js`, create the first administrator through Auth and a privileged SQL role assignment, and add reviewed/licensed products. |
| Later, after provider and account decisions | Real checkout and verified webhooks, subscriptions, server-managed entitlements, refunds, billing pages, authenticated user library, creator/admin interfaces, moderation workflows, validated upload/scanning, and payout operations. |

The current GitHub Pages site has no server-side runtime. Supabase is the selected additive backend assumption because it provides Postgres, Auth, private Storage, row-level security, and Edge Functions without replacing the static frontend. Free-tier availability and limits can change; review current Supabase terms and usage before launch. This is not a promise that production storage, bandwidth, domains, or payment processing will remain free.

## Supabase setup

1. Create a **disposable test project** separate from any production project. Review its region, pricing, privacy terms, and free-tier limits. Use no production users, data, keys, or buckets for the first test.
2. Review the migration before applying it. It creates new tables and storage buckets and is intended for a new BookWell Supabase project. It has not been run against a live database. Do not use it as a production upgrade without a reviewed backup and explicit approval. If a bucket with either BookWell bucket ID already exists with different visibility, size, or MIME rules, the migration aborts instead of changing the existing bucket.

   In Supabase CLI, verify the disposable project reference in the dashboard before linking it. Review the pending migration list/diff. Stop before `supabase db push` unless the project owner has explicitly approved applying the reviewed migration to this disposable project:

   ```powershell
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase migration list
   supabase db push --dry-run
   # Run only after explicit approval for this disposable project:
   supabase db push
   ```

   The migration is `supabase/migrations/20261025185600_marketplace_foundation.sql`. It is a first-install foundation, not a universal upgrade for an existing Supabase schema. If a BookWell database already exists, inspect its schema and data and write a separate compatible migration; do not reset it or rerun this first-install migration. SQL parsing and `--dry-run` are not substitutes for testing RLS against live PostgREST/Storage requests.
3. Deploy the secure download function to the disposable project only after the project owner explicitly approves deployment to that test project:

   ```powershell
   # Run only after explicit approval for this disposable project:
   supabase functions deploy create-download
   ```

   The managed Edge Function runtime supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Confirm that the required names exist in the project’s function settings without printing their values. Keep the service-role key server-side only. Never place it in `index.html`, `marketplace.js`, `admin.js`, `supabase-config.js`, or any public GitHub variable/file. Do not add manual secrets unless the chosen runtime explicitly requires them.
4. Set `supabase-config.js` to the project URL and **public anon key**:

   ```js
   window.BOOKWELL_CONFIG = {
     supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
     supabaseAnonKey: "YOUR_PUBLIC_ANON_KEY"
   };
   ```

   The anon key is designed to be public; authorization relies on database RLS and server-side checks, not secrecy of that key. Never use the service-role key here.
5. In the disposable project, disable public Auth sign-ups and create an administrator user through the Supabase Dashboard/invite flow. Verify the intended user's UUID in Auth, then assign the initial admin role using the privileged SQL Editor:

   ```sql
   insert into public.user_roles (user_id, role)
   values ('REPLACE_WITH_VERIFIED_AUTH_USER_UUID', 'admin')
   on conflict (user_id) do update set role = excluded.role;
   ```

   Run this only for a verified, intended administrator. Normal browser users have no insert/update/delete grant on `user_roles`; never add self-service role assignment or trust browser-provided roles.
6. Open `#admin`, sign in with the provisioned administrator, and create test listings. The browser calls PostgREST/Storage with the user access token; database RLS and Storage policies require the admin role for privileged writes. The dashboard supports metadata, category, tags/formats, INR price, status, product-file upload, preview-image upload, edits, unpublishing by status change, and deletion of products without order history.
7. `product-files` and `product-previews` must both be private buckets. The migration checks those settings and aborts on mismatched existing bucket configuration. Product files use a random filename under the product UUID folder. Preview image signing is allowed only for an admin or a published free product in an active category; preview URLs expire after five minutes. Public catalogue/detail RPCs return only published free products. The database also blocks publishing a paid product until payment processing is implemented.
8. Upload checks compare file signatures, extensions, size, and allowlisted MIME metadata. These checks are not malware scanning and do not fully validate OOXML/ZIP contents. Review/licence files before publishing. Do not upload untrusted files until a server-side malware scanning process is added.
9. Deletion is blocked when order items refer to the listing; archive/unpublish it instead. If Storage cleanup fails after a metadata change/deletion, the dashboard reports that an orphaned object may need manual cleanup.

The domain allowlist in the download function contains `https://www.bookwell.dpdns.org` and local `localhost`/`127.0.0.1` development origins. Update that list deliberately if the domain changes.

## Local development

This repository has no Node build or dependency installation. Serve the static site from the repository root:

```powershell
python -m http.server 8000
```

Open `http://localhost:8000`. Without a configured Supabase project, the website preserves its public content and displays a clear catalogue setup state; the admin interface remains disabled and the catalogue does not show invented products.

For a local Supabase CLI project, use its local API URL (typically `http://127.0.0.1:54321`) and local anon key in `supabase-config.js`. Browser configuration accepts only an HTTPS `*.supabase.co` project URL or the local loopback API on port `54321`; it rejects arbitrary HTTP hosts.

For local Edge Function development, install the Supabase CLI and Docker, then follow Supabase's local development instructions. Do not test paid access by editing browser storage; no payment or sign-in integration is present.

## Deployment

- Keep the existing GitHub Pages deployment and `CNAME` (`www.bookwell.dpdns.org`).
- Commit only the public Supabase URL/anon key configuration if desired; never commit server secrets.
- Deploy the SQL migration and Edge Function to Supabase separately from GitHub Pages.
- Verify the public catalog, RLS denial for drafts/private product data, signed URL expiry, unauthorized paid-download denial, and domain CORS behavior before publishing.
- Keep private account, checkout, and administrator routes out of public indexing when those routes are later implemented. The current site has no such routes.

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
2. Review `supabase/migrations/20261025185600_marketplace_foundation.sql`, especially grants, `SECURITY DEFINER` functions, role policies, published-product restrictions, and Storage policies. Confirm no unexpected pending migration is included. Link the CLI only to the disposable ref, inspect `supabase migration list`, run `supabase db push --dry-run`, and apply the migration only after checking the target ref again.
3. In Storage, verify `product-files` is **private**, limited to 50 MiB and the migration’s document MIME allowlist; verify `product-previews` is **private**, limited to 2 MiB and PNG/JPEG/WebP. Do not make either bucket public. Confirm the deployed policies let admins write, let users read only allowed product files, and let non-admins sign/read preview objects only for published free listings in active categories.
4. Deploy `create-download` to the disposable project using `supabase functions deploy create-download`. In function settings, confirm the expected `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and server-only `SUPABASE_SERVICE_ROLE_KEY` names are available. Keep `verify_jwt = true`. Test permitted production and localhost origins; reject an unrelated origin. Do not print or export secret values.
5. Set only the test project's URL and public anon key in the local `supabase-config.js`. Confirm the service-role key is absent from all browser-delivered files and Git history.

### Admin bootstrap and role tests

1. Disable public user sign-up in Supabase Auth. Create three test identities using the Dashboard/invite flow: one intended admin, one ordinary authenticated user with no role row (or an explicit `user` role), and one anonymous visitor with no session.
2. Verify the admin Auth UUID from the Dashboard before running the one-time `user_roles` insert shown above in the privileged SQL Editor. Never run role assignment from browser code or as a normal user. Confirm the ordinary user cannot insert/update/delete `user_roles` and cannot make `has_role('admin')` true, even by submitting an `admin` value.
3. As admin, create/edit a draft, upload a valid test document and image, publish a free listing, unpublish it, and delete a disposable listing with no dependent records. Confirm each operation and its Storage effects through the dashboard/API and database.
4. As the ordinary user, attempt direct PostgREST insert/update/delete against another user's product and direct Storage upload/replace/delete into both buckets. Every administrative write must be denied. Attempt product reads for another user's draft and confirm no row is returned.
5. As anonymous, call the public catalogue/detail RPCs for a published free listing and a draft/unpublished listing. Only the published free listing should be returned. Try direct database reads for draft rows and confirm they are denied/filtered.
6. For previews, confirm a published free product can obtain a short-lived signed preview URL, while a draft, archived, rejected, inactive-category, or otherwise unpublished product cannot. Try the legacy `/storage/v1/object/public/...` URL and verify it fails because the bucket is private. After unpublishing, verify a newly requested URL is denied; remember any previously issued signed URL remains usable until its five-minute expiry.
7. For files, confirm an anonymous user can download only an authorized published free file through the intended endpoint. Confirm a draft/unpublished file is denied through `create-download` and direct Storage requests. Attempt to publish a paid listing through both the UI and direct PostgREST; the database constraint must reject it. Do not simulate checkout or create payment entitlements.
8. Repeat the denial checks with no `Authorization` header and with an invalid/expired user token. Inspect Edge Function logs for generic errors only; confirm no tokens, file contents, or secrets are logged.

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
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Edge Function runtime only, for recording authorized download events | **Yes; server-only** |

No payment-provider variables are defined because no provider has been selected or connected. Do not take live payments until a suitable provider for the business/geography is selected and server-side checkout, signed webhook verification, idempotency, refunds, and entitlement updates are implemented and tested.

## Validation

There is no production build or pre-existing test framework. Run the dependency-free frontend logic/security regression tests and syntax checks with:

```powershell
node --test tests/security-foundation.test.js
node --check marketplace.js
node --check admin.js
git diff --check
```

These tests exercise pure catalogue-query construction, product metadata/file validation, response-shape checks and static migration/function invariants. They do not exercise PostgreSQL RLS or real Supabase Auth/Storage/Edge Function behavior. Those must additionally be tested against a disposable project with anonymous, ordinary, and administrator accounts before production setup. This repository does not claim that a production backend, payment flow, subscription, upload scanner, or live deployment has been tested.
