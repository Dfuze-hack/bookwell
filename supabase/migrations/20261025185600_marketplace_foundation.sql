begin;

create extension if not exists pgcrypto;

create table public.user_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'creator', 'admin')),
  created_at timestamptz not null default now()
);

create table public.creator_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (length(trim(display_name)) between 1 and 80),
  biography text not null default '' check (length(biography) <= 2000),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users (id) on delete restrict,
  category_id uuid not null references public.categories (id) on delete restrict,
  title text not null check (length(trim(title)) between 3 and 160),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text not null check (length(trim(description)) between 10 and 10000),
  tags text[] not null default '{}',
  formats text[] not null default '{}',
  license text not null check (length(trim(license)) between 2 and 120),
  preview_url text check (preview_url is null),
  preview_path text,
  file_path text not null,
  price_minor integer not null default 0 check (price_minor >= 0),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  included_with_premium boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'pending', 'rejected', 'published', 'archived')),
  constraint products_file_path_belongs_to_product check (
    file_path like id::text || '/%'
    and file_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(pdf|zip|docx|pptx|xlsx)$'
  ),
  search_document tsvector generated always as (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || array_to_string(tags, ' '))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_file_path_not_empty check (length(trim(file_path)) > 0),
  constraint products_preview_path_safe check (
    preview_path is null or preview_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(png|jpg|webp)$'
  ),
  constraint products_published_free_only check (status <> 'published' or price_minor = 0)
);

create index products_publication_idx on public.products (status, updated_at desc);
create index products_category_idx on public.products (category_id, status);
create index products_search_idx on public.products using gin (search_document);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.audit_product_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_id uuid;
  details jsonb;
begin
  if tg_op = 'DELETE' then
    target_id := old.id;
    details := jsonb_build_object('status', old.status);
  elsif tg_op = 'INSERT' then
    target_id := new.id;
    details := jsonb_build_object('status', new.status);
  else
    target_id := new.id;
    details := jsonb_build_object('old_status', old.status, 'new_status', new.status);
  end if;

  insert into public.audit_logs (actor_id, action, target_type, target_id, details)
  values (auth.uid(), lower(tg_op), 'product', target_id::text, details);

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger products_set_updated_at before update on public.products
for each row execute function public.set_updated_at();

create trigger products_audit_change after insert or update or delete on public.products
for each row execute function public.audit_product_change();

create trigger creator_profiles_set_updated_at before update on public.creator_profiles
for each row execute function public.set_updated_at();

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'cancelled', 'refunded', 'partially_refunded')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  total_minor integer not null check (total_minor >= 0),
  provider text,
  provider_checkout_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger orders_set_updated_at before update on public.orders
for each row execute function public.set_updated_at();

create index orders_user_idx on public.orders (user_id, created_at desc);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete restrict,
  product_id uuid not null references public.products (id) on delete restrict,
  unit_price_minor integer not null check (unit_price_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  refunded_minor integer not null default 0 check (refunded_minor >= 0 and refunded_minor <= unit_price_minor),
  unique (order_id, product_id)
);

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create table public.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor integer not null check (amount_minor >= 0),
  billing_interval text not null check (billing_interval in ('month', 'year')),
  benefits jsonb not null default '[]'::jsonb check (jsonb_typeof(benefits) = 'array'),
  is_active boolean not null default false,
  provider_price_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger subscription_plans_set_updated_at before update on public.subscription_plans
for each row execute function public.set_updated_at();

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  plan_id uuid not null references public.subscription_plans (id) on delete restrict,
  status text not null check (status in ('pending', 'active', 'past_due', 'cancelled', 'expired', 'failed')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  provider_subscription_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger subscriptions_set_updated_at before update on public.subscriptions
for each row execute function public.set_updated_at();

create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  product_id uuid references public.products (id) on delete cascade,
  subscription_id uuid references public.subscriptions (id) on delete cascade,
  source text not null check (source in ('purchase', 'subscription', 'admin_grant')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  check (product_id is not null or subscription_id is not null)
);

create unique index entitlements_product_unique on public.entitlements (user_id, product_id) where product_id is not null;
create index entitlements_user_active_idx on public.entitlements (user_id, ends_at);

create table public.saved_products (
  user_id uuid not null references auth.users (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, product_id)
);

create table public.download_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  product_id uuid not null references public.products (id) on delete restrict,
  created_at timestamptz not null default now()
);

create index download_events_product_idx on public.download_events (product_id, created_at desc);

create table public.collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.collection_products (
  collection_id uuid not null references public.collections (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (collection_id, product_id)
);

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  body text not null default '' check (length(body) <= 2000),
  status text not null default 'pending' check (status in ('pending', 'published', 'rejected')),
  created_at timestamptz not null default now(),
  unique (user_id, product_id)
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references auth.users (id) on delete set null,
  product_id uuid not null references public.products (id) on delete cascade,
  reason text not null check (length(trim(reason)) between 3 and 1000),
  status text not null default 'open' check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.payout_ledger (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users (id) on delete restrict,
  order_item_id uuid references public.order_items (id) on delete restrict,
  entry_type text not null check (entry_type in ('sale', 'refund', 'commission', 'payment_fee', 'payout')),
  amount_minor integer not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  provider_reference text unique,
  created_at timestamptz not null default now()
);

create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users (id) on delete restrict,
  amount_minor integer not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'requested' check (status in ('requested', 'approved', 'paid', 'rejected')),
  provider_reference text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger payouts_set_updated_at before update on public.payouts
for each row execute function public.set_updated_at();

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users (id) on delete set null,
  action text not null,
  target_type text not null,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.has_role(required_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = (select auth.uid()) and role = required_role
  );
$$;

create or replace function public.search_public_products(
  p_search text default null,
  p_category text default null,
  p_price_type text default null,
  p_file_format text default null,
  p_sort text default 'newest',
  p_limit integer default 12,
  p_offset integer default 0,
  p_min_price_minor integer default null,
  p_max_price_minor integer default null,
  p_currency text default null
)
returns table (
  id uuid, title text, slug text, description text, tags text[], formats text[],
  license text, preview_path text, price_minor integer, currency text,
  included_with_premium boolean, updated_at timestamptz, category_name text,
  creator_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.title, p.slug, p.description, p.tags, p.formats, p.license,
         p.preview_path, p.price_minor, p.currency, p.included_with_premium,
         p.updated_at, c.name, cp.display_name
  from public.products p
  join public.categories c on c.id = p.category_id
  join public.creator_profiles cp on cp.user_id = p.creator_id
  where p.status = 'published'
    and p.price_minor = 0
    and c.is_active
    and (
      p_search is null
      or p.search_document @@ websearch_to_tsquery('simple', p_search)
      or to_tsvector('simple', c.name) @@ websearch_to_tsquery('simple', p_search)
    )
    and (p_category is null or c.slug = p_category)
    and (p_price_type is null or (p_price_type = 'free' and p.price_minor = 0) or (p_price_type = 'paid' and p.price_minor > 0))
    and (p_file_format is null or p_file_format = any (p.formats))
    and (p_min_price_minor is null or p.price_minor >= greatest(p_min_price_minor, 0))
    and (p_max_price_minor is null or p.price_minor <= greatest(p_max_price_minor, 0))
    and (p_currency is null or p.currency = p_currency)
  order by
    case when p_sort = 'title' then lower(p.title) end asc,
    case when p_sort in ('price_asc', 'price_desc') then p.currency end asc,
    case when p_sort = 'price_asc' then p.price_minor end asc,
    case when p_sort = 'price_desc' then p.price_minor end desc,
    case when p_sort not in ('title', 'price_asc', 'price_desc') then p.updated_at end desc,
    p.id
  limit least(greatest(coalesce(p_limit, 12), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.creator_profile_is_public(target_creator uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.products p
    where p.creator_id = target_creator and p.status = 'published'
  );
$$;

create or replace function public.public_product_by_slug(p_slug text)
returns table (
  id uuid, title text, slug text, description text, tags text[], formats text[],
  license text, preview_path text, price_minor integer, currency text,
  included_with_premium boolean, updated_at timestamptz, category_name text,
  creator_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.title, p.slug, p.description, p.tags, p.formats, p.license,
         p.preview_path, p.price_minor, p.currency, p.included_with_premium,
         p.updated_at, c.name, cp.display_name
  from public.products p
  join public.categories c on c.id = p.category_id
  join public.creator_profiles cp on cp.user_id = p.creator_id
  where p.slug = p_slug and p.status = 'published' and p.price_minor = 0 and c.is_active
  limit 1;
$$;

create or replace function public.can_download_product(target_product uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.products p
    where p.id = target_product and p.status = 'published' and (
      p.price_minor = 0
      or p.creator_id = (select auth.uid())
      or public.has_role('admin')
      or exists (
        select 1 from public.entitlements e
        where e.user_id = (select auth.uid())
          and e.product_id = p.id
          and e.source = 'admin_grant'
          and e.starts_at <= now()
          and (e.ends_at is null or e.ends_at > now())
      )
      or exists (
        select 1 from public.orders o
        join public.order_items oi on oi.order_id = o.id
        where o.user_id = (select auth.uid())
          and o.status = 'paid'
          and oi.product_id = p.id
          and oi.refunded_minor < oi.unit_price_minor
      )
      or (
        p.included_with_premium
        and exists (
          select 1 from public.entitlements e
          join public.subscriptions s on s.id = e.subscription_id
          where e.user_id = (select auth.uid())
            and s.user_id = e.user_id
            and (
              s.status = 'active'
              or (s.status = 'cancelled' and s.cancel_at_period_end)
            )
            and s.current_period_end > now()
            and e.starts_at <= now()
            and (e.ends_at is null or e.ends_at > now())
        )
      )
    )
  );
$$;

create or replace function public.get_authorized_download_path(target_product uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.file_path
  from public.products p
  where p.id = target_product
    and p.status = 'published'
    and public.can_download_product(p.id);
$$;

create or replace function public.public_product_reviews(target_product uuid)
returns table (rating smallint, body text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select r.rating, r.body, r.created_at
  from public.reviews r
  join public.products p on p.id = r.product_id
  where r.product_id = target_product
    and r.status = 'published'
    and p.status = 'published'
  order by r.created_at desc
  limit 100;
$$;

alter table public.user_roles enable row level security;
alter table public.creator_profiles enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.payment_events enable row level security;
alter table public.subscription_plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.entitlements enable row level security;
alter table public.saved_products enable row level security;
alter table public.download_events enable row level security;
alter table public.collections enable row level security;
alter table public.collection_products enable row level security;
alter table public.reviews enable row level security;
alter table public.reports enable row level security;
alter table public.payout_ledger enable row level security;
alter table public.payouts enable row level security;
alter table public.audit_logs enable row level security;

create policy "Users can read their own roles" on public.user_roles for select to authenticated using (user_id = (select auth.uid()));
create policy "Admins manage roles" on public.user_roles for all to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));

create policy "Public creator profiles for published listings" on public.creator_profiles for select to anon, authenticated using (
  user_id = (select auth.uid()) or public.has_role('admin')
  or public.creator_profile_is_public(user_id)
);
create policy "Creators manage own public profile" on public.creator_profiles for insert to authenticated with check (
  user_id = (select auth.uid()) and public.has_role('creator')
);
create policy "Creators update own public profile" on public.creator_profiles for update to authenticated using (
  user_id = (select auth.uid()) and public.has_role('creator')
) with check (
  user_id = (select auth.uid()) and public.has_role('creator')
);

create policy "Public active categories" on public.categories for select to anon, authenticated using (is_active or public.has_role('admin'));
create policy "Admins manage categories" on public.categories for all to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));

create policy "Published products are public" on public.products for select to anon, authenticated using (
  status = 'published' or creator_id = (select auth.uid()) or public.has_role('admin')
);
create policy "Creators submit drafts" on public.products for insert to authenticated with check (
  creator_id = (select auth.uid()) and public.has_role('creator') and status in ('draft', 'pending')
);
create policy "Creators edit own unapproved products" on public.products for update to authenticated using (
  creator_id = (select auth.uid()) and status in ('draft', 'pending', 'rejected')
) with check (
  creator_id = (select auth.uid()) and status in ('draft', 'pending', 'rejected')
);
create policy "Admins manage products" on public.products for all to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));

revoke all on public.products from anon, authenticated;
grant select, insert, update, delete on public.products to authenticated;

create policy "Users read own orders" on public.orders for select to authenticated using (user_id = (select auth.uid()) or public.has_role('admin'));
create policy "Users read own order items" on public.order_items for select to authenticated using (
  exists (select 1 from public.orders o where o.id = order_id and (o.user_id = (select auth.uid()) or public.has_role('admin')))
);
create policy "Admins read payment events" on public.payment_events for select to authenticated using (public.has_role('admin'));
create policy "Public active plans" on public.subscription_plans for select to anon, authenticated using (is_active or public.has_role('admin'));
create policy "Users read own subscriptions" on public.subscriptions for select to authenticated using (user_id = (select auth.uid()) or public.has_role('admin'));
create policy "Users read own entitlements" on public.entitlements for select to authenticated using (user_id = (select auth.uid()) or public.has_role('admin'));

create policy "Users manage own saved products" on public.saved_products for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Users read own download history" on public.download_events for select to authenticated using (user_id = (select auth.uid()) or public.has_role('admin'));
create policy "Users manage own collections" on public.collections for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Users manage own collection products" on public.collection_products for all to authenticated using (
  exists (select 1 from public.collections c where c.id = collection_id and c.user_id = (select auth.uid()))
) with check (
  exists (select 1 from public.collections c where c.id = collection_id and c.user_id = (select auth.uid()))
);
create policy "Users read own and admins read reviews" on public.reviews for select to authenticated using (
  user_id = (select auth.uid()) or public.has_role('admin')
);
create policy "Users submit reviews" on public.reviews for insert to authenticated with check (
  user_id = (select auth.uid()) and status = 'pending' and exists (
    select 1 from public.orders o join public.order_items oi on oi.order_id = o.id
    where o.user_id = (select auth.uid()) and o.status = 'paid' and oi.product_id = reviews.product_id
  )
);
create policy "Users report products" on public.reports for insert to authenticated with check (
  reporter_id = (select auth.uid()) and status = 'open' and resolved_at is null
);
create policy "Admins moderate reports" on public.reports for all to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));
create policy "Creators read own payout ledger" on public.payout_ledger for select to authenticated using (creator_id = (select auth.uid()) or public.has_role('admin'));
create policy "Creators read own payouts" on public.payouts for select to authenticated using (creator_id = (select auth.uid()) or public.has_role('admin'));
create policy "Admins manage payouts" on public.payouts for update to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));
create policy "Admins read audit logs" on public.audit_logs for select to authenticated using (public.has_role('admin'));

grant usage on schema public to anon, authenticated;
grant usage on schema public to service_role;
grant select on public.categories, public.products, public.creator_profiles, public.subscription_plans to anon, authenticated;
grant select on public.reviews to authenticated;
grant select, insert, update on public.creator_profiles to authenticated;
grant select on public.user_roles, public.orders, public.order_items, public.subscriptions, public.entitlements to authenticated;
grant select on public.download_events to authenticated;
grant select, insert, update, delete on public.saved_products, public.collections, public.collection_products to authenticated;
grant select, insert on public.reviews, public.reports to authenticated;
grant select on public.payout_ledger, public.payouts to authenticated;
grant update on public.payouts to authenticated;
grant select on public.payment_events, public.audit_logs to authenticated;
grant insert on public.download_events to service_role;

grant execute on function public.has_role(text) to anon, authenticated;
grant execute on function public.search_public_products(text, text, text, text, text, integer, integer, integer, integer, text) to anon, authenticated;
grant execute on function public.public_product_by_slug(text) to anon, authenticated;
grant execute on function public.creator_profile_is_public(uuid) to anon, authenticated;
grant execute on function public.can_download_product(uuid) to anon, authenticated;
grant execute on function public.get_authorized_download_path(uuid) to anon, authenticated;
grant execute on function public.public_product_reviews(uuid) to anon, authenticated;

insert into public.categories (name, slug) values
  ('Study resources', 'study-resources'),
  ('Study planners and productivity', 'study-planners-productivity'),
  ('Notion templates and digital planners', 'notion-templates-digital-planners'),
  ('Presentation templates', 'presentation-templates'),
  ('Programming resources and project templates', 'programming-project-templates'),
  ('Research and project planning', 'research-project-planning'),
  ('Worksheets and practice materials', 'worksheets-practice-materials'),
  ('Other approved resources', 'other-approved-resources')
on conflict (slug) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-files', 'product-files', false, 52428800, array['application/pdf', 'application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-previews', 'product-previews', false, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

do $$
declare
  private_bucket record;
  preview_bucket record;
begin
  select public, file_size_limit, allowed_mime_types
    into private_bucket
    from storage.buckets
    where id = 'product-files';
  if not found
    or private_bucket.public
    or private_bucket.file_size_limit <> 52428800
    or private_bucket.allowed_mime_types <> array[
      'application/pdf', 'application/zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ] then
    raise exception 'Existing product-files bucket does not match the required private BookWell configuration; review it manually.';
  end if;

  select public, file_size_limit, allowed_mime_types
    into preview_bucket
    from storage.buckets
    where id = 'product-previews';
  if not found
    or preview_bucket.public
    or preview_bucket.file_size_limit <> 2097152
    or preview_bucket.allowed_mime_types <> array['image/png', 'image/jpeg', 'image/webp'] then
    raise exception 'Existing product-previews bucket does not match the required BookWell configuration; review it manually.';
  end if;
end;
$$;

create policy "Authorized users can download published product files" on storage.objects
for select to anon, authenticated using (
  bucket_id = 'product-files'
  and public.can_download_product(((storage.foldername(name))[1])::uuid)
);
create policy "Admins manage product files" on storage.objects
for all to authenticated using (bucket_id = 'product-files' and public.has_role('admin'))
with check (bucket_id = 'product-files' and public.has_role('admin'));

create policy "Published free product previews are readable" on storage.objects
for select to anon, authenticated using (
  bucket_id = 'product-previews'
  and (
    public.has_role('admin')
    or exists (
      select 1
      from public.products p
      join public.categories c on c.id = p.category_id
      where p.id = case
        when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then ((storage.foldername(name))[1])::uuid
        else null
      end
        and p.status = 'published'
        and p.price_minor = 0
        and c.is_active
    )
  )
);
create policy "Admins manage product previews" on storage.objects
for all to authenticated using (bucket_id = 'product-previews' and public.has_role('admin'))
with check (bucket_id = 'product-previews' and public.has_role('admin'));

commit;
