begin;

-- Commerce tables, trusted purchase flow, and restricted product metadata reads.

alter table public.products
  drop constraint if exists products_published_free_only,
  add column language text check (language is null or length(trim(language)) between 2 and 80);

alter table public.orders
  add column client_request_id uuid,
  add column provider_payment_id text,
  add column verified_at timestamptz,
  add column checkout_started_at timestamptz,
  add column failure_code text;

create unique index orders_user_request_unique
  on public.orders (user_id, client_request_id)
  where client_request_id is not null;

create unique index orders_provider_payment_unique
  on public.orders (provider, provider_payment_id)
  where provider is not null and provider_payment_id is not null;

create index order_items_product_order_idx
  on public.order_items (product_id, order_id);

drop function public.search_public_products(text, text, text, text, text, integer, integer, integer, integer, text);
create function public.search_public_products(
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
  license text, preview_path text, price_minor integer, currency text, language text,
  included_with_premium boolean, updated_at timestamptz, category_name text,
  creator_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.title, p.slug, p.description, p.tags, p.formats, p.license,
         case when p.price_minor = 0 then p.preview_path else null end,
         p.price_minor, p.currency, p.language, p.included_with_premium,
         p.updated_at, c.name, cp.display_name
  from public.products p
  join public.categories c on c.id = p.category_id
  join public.creator_profiles cp on cp.user_id = p.creator_id
  where p.status = 'published'
    and c.is_active
    and (
      p_search is null
      or p.search_document @@ websearch_to_tsquery('simple', p_search)
      or to_tsvector('simple', c.name) @@ websearch_to_tsquery('simple', p_search)
    )
    and (p_category is null or c.slug = p_category)
    and (p_price_type is null
      or (p_price_type = 'free' and p.price_minor = 0)
      or (p_price_type = 'paid' and p.price_minor > 0))
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

drop function public.public_product_by_slug(text);
create function public.public_product_by_slug(p_slug text)
returns table (
  id uuid, title text, slug text, description text, tags text[], formats text[],
  license text, preview_path text, price_minor integer, currency text, language text,
  included_with_premium boolean, updated_at timestamptz, category_name text,
  creator_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.title, p.slug, p.description, p.tags, p.formats, p.license,
         case when p.price_minor = 0 then p.preview_path else null end,
         p.price_minor, p.currency, p.language, p.included_with_premium,
         p.updated_at, c.name, cp.display_name
  from public.products p
  join public.categories c on c.id = p.category_id
  join public.creator_profiles cp on cp.user_id = p.creator_id
  where p.slug = p_slug and p.status = 'published' and c.is_active
  limit 1;
$$;

drop function if exists public.admin_list_products();
create function public.admin_list_products()
returns table (
  id uuid, creator_id uuid, category_id uuid, title text, slug text,
  description text, tags text[], formats text[], license text,
  preview_path text, file_path text, price_minor integer, currency text, language text,
  included_with_premium boolean, status text, updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.creator_id, p.category_id, p.title, p.slug, p.description,
         p.tags, p.formats, p.license, p.preview_path, p.file_path,
         p.price_minor, p.currency, p.language, p.included_with_premium, p.status, p.updated_at
  from public.products p
  where public.has_role('admin')
  order by p.updated_at desc
  limit 500;
$$;

revoke all on public.products from public, anon, authenticated;
grant select (
  id, creator_id, category_id, title, slug, description, tags, formats,
  license, preview_path, price_minor, currency, language, included_with_premium,
  status, updated_at, created_at
) on public.products to anon, authenticated;
grant insert, update, delete on public.products to authenticated;

revoke all on function public.search_public_products(text, text, text, text, text, integer, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.search_public_products(text, text, text, text, text, integer, integer, integer, integer, text) to anon, authenticated;
revoke all on function public.public_product_by_slug(text) from public, anon, authenticated;
grant execute on function public.public_product_by_slug(text) to anon, authenticated;
revoke all on function public.admin_list_products() from public, anon, authenticated;
grant execute on function public.admin_list_products() to authenticated;

create or replace function public.user_can_download_product(
  target_product uuid,
  target_user uuid
)
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
      or (target_user is not null and (
        p.creator_id = target_user
        or exists (
          select 1 from public.user_roles r
          where r.user_id = target_user and r.role = 'admin'
        )
        or exists (
          select 1 from public.entitlements e
          where e.user_id = target_user
            and e.product_id = p.id
            and e.source = 'admin_grant'
            and e.starts_at <= now()
            and (e.ends_at is null or e.ends_at > now())
        )
        or exists (
          select 1 from public.orders o
          join public.order_items oi on oi.order_id = o.id
          where o.user_id = target_user
            and o.status = 'paid'
            and oi.product_id = p.id
            and oi.refunded_minor < oi.unit_price_minor
        )
        or (
          p.included_with_premium
          and exists (
            select 1 from public.entitlements e
            join public.subscriptions s on s.id = e.subscription_id
            where e.user_id = target_user
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
      ))
    )
  );
$$;

revoke all on function public.user_can_download_product(uuid, uuid) from public, anon, authenticated;
grant execute on function public.user_can_download_product(uuid, uuid) to service_role;

create or replace function public.can_download_product(target_product uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.user_can_download_product(target_product, (select auth.uid()));
$$;

drop function public.get_authorized_download_path(uuid);
create function public.get_authorized_download_path(
  target_product uuid,
  target_user uuid
)
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
    and public.user_can_download_product(p.id, target_user);
$$;

revoke all on function public.get_authorized_download_path(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_authorized_download_path(uuid, uuid) to service_role;

create or replace function public.create_product_purchase(
  target_product uuid,
  request_key uuid
)
returns table (
  order_id uuid,
  product_id uuid,
  product_title text,
  amount_minor integer,
  currency text,
  purchase_status text,
  provider text,
  provider_checkout_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  customer uuid := (select auth.uid());
  product_row public.products%rowtype;
  existing_order public.orders%rowtype;
  new_order_id uuid;
begin
  if customer is null then
    raise exception 'Authentication required.';
  end if;
  if request_key is null then
    raise exception 'A valid idempotency key is required.';
  end if;

  select p.* into product_row
  from public.products p
  join public.categories c on c.id = p.category_id
  where p.id = target_product
    and p.status = 'published'
    and c.is_active
    and p.price_minor > 0
  for update of p;
  if not found then
    raise exception 'This product is unavailable for purchase.';
  end if;

  select o.* into existing_order
  from public.orders o
  where o.user_id = customer and o.client_request_id = request_key;
  if found then
    if not exists (
      select 1 from public.order_items oi
      where oi.order_id = existing_order.id and oi.product_id = target_product
    ) then
      raise exception 'The idempotency key is already associated with another purchase.';
    end if;
    return query select existing_order.id, product_row.id, product_row.title,
      existing_order.total_minor, existing_order.currency, existing_order.status,
      existing_order.provider, existing_order.provider_checkout_id;
    return;
  end if;

  if (select count(*) from public.orders o
      where o.user_id = customer
        and o.created_at > now() - interval '1 hour'
        and o.status in ('pending', 'failed', 'cancelled')) >= 5 then
    raise exception 'Too many recent checkout attempts. Please try again later.';
  end if;

  if public.can_download_product(target_product) then
    raise exception 'This account already has access to this product.';
  end if;

  select o.* into existing_order
  from public.orders o
  join public.order_items oi on oi.order_id = o.id
  where o.user_id = customer and oi.product_id = target_product
    and o.status = 'pending'
  order by o.created_at desc
  limit 1;
  if found then
    return query select existing_order.id, product_row.id, product_row.title,
      existing_order.total_minor, existing_order.currency, existing_order.status,
      existing_order.provider, existing_order.provider_checkout_id;
    return;
  end if;

  insert into public.orders (user_id, status, currency, total_minor, client_request_id)
  values (customer, 'pending', product_row.currency, product_row.price_minor, request_key)
  returning id into new_order_id;

  insert into public.order_items (order_id, product_id, unit_price_minor, currency)
  values (new_order_id, product_row.id, product_row.price_minor, product_row.currency);

  return query select new_order_id, product_row.id, product_row.title,
    product_row.price_minor, product_row.currency, 'pending'::text, null::text, null::text;
end;
$$;

create or replace function public.claim_product_purchase_checkout(target_order uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean;
begin
  update public.orders o
  set checkout_started_at = now()
  where o.id = target_order
    and o.status = 'pending'
    and o.provider_checkout_id is null
    and (o.checkout_started_at is null or o.checkout_started_at < now() - interval '5 minutes');
  claimed := found;
  return claimed;
end;
$$;

create or replace function public.bind_product_purchase_checkout(
  target_order uuid,
  payment_provider text,
  checkout_reference text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  bound boolean;
begin
  if payment_provider !~ '^[a-z0-9_-]{2,40}$'
    or checkout_reference is null
    or length(checkout_reference) not between 1 and 255 then
    raise exception 'Invalid provider checkout reference.';
  end if;
  update public.orders o
  set provider = payment_provider,
      provider_checkout_id = checkout_reference,
      checkout_started_at = null
  where o.id = target_order
    and o.status = 'pending'
    and o.provider_checkout_id is null
    and o.checkout_started_at is not null;
  bound := found;
  return bound;
end;
$$;

create or replace function public.release_product_purchase_checkout(target_order uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.orders
  set checkout_started_at = null
  where id = target_order
    and status = 'pending'
    and provider_checkout_id is null;
$$;

create or replace function public.fail_product_purchase_setup(
  target_order uuid,
  safe_failure_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.orders
  set status = 'failed',
      failure_code = case
        when safe_failure_code ~ '^[A-Za-z0-9_.-]{1,80}$' then safe_failure_code
        else 'checkout_setup_failed'
      end,
      checkout_started_at = null
  where id = target_order and status = 'pending' and provider_checkout_id is null;
end;
$$;

create or replace function public.process_verified_product_payment_event(
  payment_provider text,
  provider_event_id text,
  provider_event_type text,
  checkout_reference text,
  payment_reference text,
  verified_status text,
  verified_amount_minor integer,
  verified_currency text,
  refunded_amount_minor integer default 0,
  safe_failure_code text default null
)
returns table (outcome text, order_id uuid, purchase_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  payment_order public.orders%rowtype;
  payment_item public.order_items%rowtype;
  inserted_event_id uuid;
  next_status text;
begin
  if payment_provider is null or payment_provider !~ '^[a-z0-9_-]{2,40}$'
    or provider_event_id is null or length(provider_event_id) not between 1 and 255
    or provider_event_type is null or length(provider_event_type) not between 1 and 120
    or checkout_reference is null or length(checkout_reference) not between 1 and 255
    or verified_status is null or verified_status not in ('paid', 'failed', 'cancelled', 'refunded', 'partially_refunded')
    or verified_amount_minor is null or verified_amount_minor < 1
    or verified_currency is null or verified_currency !~ '^[A-Z]{3}$'
    or refunded_amount_minor is null or refunded_amount_minor < 0
    or (safe_failure_code is not null and safe_failure_code !~ '^[A-Za-z0-9_.-]{1,80}$') then
    raise exception 'Invalid verified payment event.';
  end if;

  insert into public.payment_events (provider, provider_event_id, event_type)
  values (payment_provider, provider_event_id, provider_event_type)
  on conflict on constraint payment_events_provider_provider_event_id_key do nothing
  returning id into inserted_event_id;

  if inserted_event_id is null then
    return query select 'duplicate'::text, null::uuid, null::text;
    return;
  end if;

  select o.*
  into payment_order
  from public.orders o
  join public.order_items oi on oi.order_id = o.id
  where o.provider = payment_provider
    and o.provider_checkout_id = checkout_reference
  for update of o, oi;

  if not found then
    raise exception 'No matching purchase exists for the verified payment.';
  end if;

  select oi.* into payment_item
  from public.order_items oi
  where oi.order_id = payment_order.id
  order by oi.id
  limit 1
  for update;

  if payment_order.total_minor <> verified_amount_minor
    or payment_order.currency <> verified_currency
    or payment_item.unit_price_minor <> verified_amount_minor
    or payment_item.currency <> verified_currency then
    raise exception 'Verified payment amount does not match the purchase record.';
  end if;

  if payment_reference is not null and (
    length(payment_reference) not between 1 and 255
    or (payment_order.provider_payment_id is not null
      and payment_order.provider_payment_id <> payment_reference)
  ) then
    raise exception 'Payment reference does not match the purchase record.';
  end if;

  if verified_status = 'paid' then
    if refunded_amount_minor <> 0 or payment_order.status in ('refunded', 'partially_refunded') then
      raise exception 'Invalid successful payment transition.';
    end if;
    update public.orders
    set status = 'paid',
        verified_at = coalesce(verified_at, now()),
        provider_payment_id = coalesce(provider_payment_id, payment_reference),
        failure_code = null
    where id = payment_order.id;
    insert into public.entitlements (user_id, product_id, source)
    select payment_order.user_id, payment_item.product_id, 'purchase'
    where not exists (
      select 1 from public.entitlements e
      where e.user_id = payment_order.user_id
        and e.product_id = payment_item.product_id
        and e.source <> 'purchase'
        and (e.ends_at is null or e.ends_at > now())
    )
    on conflict (user_id, product_id) where product_id is not null
    do update set starts_at = now(), ends_at = null
      where entitlements.source = 'purchase';

    next_status := 'paid';
  elsif verified_status in ('failed', 'cancelled') then
    if refunded_amount_minor <> 0 then
      raise exception 'A failed or cancelled payment cannot include a refund.';
    end if;
    if payment_order.status = 'pending' then
      update public.orders
      set status = verified_status,
          failure_code = safe_failure_code
      where id = payment_order.id;
    end if;
    next_status := case
      when payment_order.status in ('paid', 'partially_refunded', 'refunded') then payment_order.status
      when payment_order.status in ('failed', 'cancelled') then payment_order.status
      else verified_status
    end;
  else
    if payment_order.status not in ('paid', 'partially_refunded')
      or refunded_amount_minor <= payment_item.refunded_minor
      or refunded_amount_minor > payment_item.unit_price_minor
      or (verified_status = 'refunded' and refunded_amount_minor <> payment_item.unit_price_minor)
      or (verified_status = 'partially_refunded' and refunded_amount_minor >= payment_item.unit_price_minor) then
      raise exception 'Invalid refund transition.';
    end if;
    next_status := case when refunded_amount_minor = payment_item.unit_price_minor
      then 'refunded' else 'partially_refunded' end;
    update public.order_items
    set refunded_minor = refunded_amount_minor
    where id = payment_item.id;
    update public.orders
    set status = next_status
    where id = payment_order.id;
    update public.entitlements
    set ends_at = now()
    where user_id = payment_order.user_id
      and product_id = payment_item.product_id
      and source = 'purchase'
      and (ends_at is null or ends_at > now());
  end if;

  update public.payment_events
  set processed_at = now()
  where id = inserted_event_id;

  return query select 'processed'::text, payment_order.id, next_status;
end;
$$;

revoke all on function public.create_product_purchase(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_product_purchase(uuid, uuid) to authenticated;

revoke all on function public.claim_product_purchase_checkout(uuid) from public, anon, authenticated;
revoke all on function public.bind_product_purchase_checkout(uuid, text, text) from public, anon, authenticated;
revoke all on function public.release_product_purchase_checkout(uuid) from public, anon, authenticated;
revoke all on function public.fail_product_purchase_setup(uuid, text) from public, anon, authenticated;
revoke all on function public.process_verified_product_payment_event(text, text, text, text, text, text, integer, text, integer, text) from public, anon, authenticated;
grant execute on function public.claim_product_purchase_checkout(uuid) to service_role;
grant execute on function public.bind_product_purchase_checkout(uuid, text, text) to service_role;
grant execute on function public.release_product_purchase_checkout(uuid) to service_role;
grant execute on function public.fail_product_purchase_setup(uuid, text) to service_role;
grant execute on function public.process_verified_product_payment_event(text, text, text, text, text, text, integer, text, integer, text) to service_role;

revoke insert, update, delete on public.orders, public.order_items, public.payment_events, public.entitlements from anon, authenticated;
grant update on public.orders to service_role;
grant insert, update on public.order_items, public.payment_events, public.entitlements to service_role;

drop policy if exists "Published free product previews are readable" on storage.objects;
create policy "Published product previews are readable" on storage.objects
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

commit;
