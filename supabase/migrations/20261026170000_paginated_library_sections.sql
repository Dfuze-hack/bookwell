begin;

create index if not exists products_library_created_idx
  on public.products (created_at desc, id desc);

create index if not exists orders_user_paid_verified_idx
  on public.orders (user_id, created_at desc)
  where status = 'paid' and verified_at is not null;

create or replace function public.list_my_purchase_products(
  p_limit integer default 24,
  p_before_purchased_at timestamptz default null,
  p_before_product_id uuid default null
)
returns table (
  id uuid,
  title text,
  slug text,
  description text,
  formats text[],
  preview_path text,
  price_minor integer,
  currency text,
  updated_at timestamptz,
  status text,
  purchased_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  customer uuid := (select auth.uid());
  page_limit integer := least(greatest(coalesce(p_limit, 24), 1), 50);
begin
  if customer is null then
    raise exception 'Authentication required.';
  end if;
  if (p_before_purchased_at is null) <> (p_before_product_id is null) then
    raise exception 'Both pagination cursor values are required.';
  end if;

  return query
  with eligible_purchases as (
    select p.id, p.title, p.slug, p.description, p.formats,
           p.preview_path, p.price_minor, p.currency, p.updated_at, p.status,
           max(o.created_at) as purchased_at
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
    join public.products p on p.id = oi.product_id
    where o.user_id = customer
      and o.status = 'paid'
      and o.verified_at is not null
      and oi.refunded_minor < oi.unit_price_minor
      and public.user_can_download_product(p.id, customer)
    group by p.id
  )
  select e.id, e.title, e.slug, e.description, e.formats,
         e.preview_path, e.price_minor, e.currency, e.updated_at, e.status,
         e.purchased_at
  from eligible_purchases e
  where p_before_purchased_at is null
     or (e.purchased_at, e.id) < (p_before_purchased_at, p_before_product_id)
  order by e.purchased_at desc, e.id desc
  limit page_limit;
end;
$$;

create or replace function public.list_my_free_downloads(
  p_limit integer default 24,
  p_before_created_at timestamptz default null,
  p_before_product_id uuid default null
)
returns table (
  id uuid,
  title text,
  slug text,
  description text,
  formats text[],
  preview_path text,
  price_minor integer,
  currency text,
  updated_at timestamptz,
  status text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  customer uuid := (select auth.uid());
  page_limit integer := least(greatest(coalesce(p_limit, 24), 1), 50);
begin
  if customer is null then
    raise exception 'Authentication required.';
  end if;
  if (p_before_created_at is null) <> (p_before_product_id is null) then
    raise exception 'Both pagination cursor values are required.';
  end if;

  return query
  select p.id, p.title, p.slug, p.description, p.formats,
         p.preview_path, p.price_minor, p.currency, p.updated_at, p.status,
         p.created_at
  from public.products p
  where p.status = 'published'
    and p.price_minor = 0
    and public.user_can_download_product(p.id, customer)
    and not exists (
      select 1
      from public.orders o
      join public.order_items oi on oi.order_id = o.id
      where o.user_id = customer
        and o.status = 'paid'
        and o.verified_at is not null
        and oi.product_id = p.id
        and oi.refunded_minor < oi.unit_price_minor
    )
    and (
      p_before_created_at is null
      or (p.created_at, p.id) < (p_before_created_at, p_before_product_id)
    )
  order by p.created_at desc, p.id desc
  limit page_limit;
end;
$$;

create or replace function public.list_my_additional_access_products(
  p_limit integer default 24,
  p_before_created_at timestamptz default null,
  p_before_product_id uuid default null
)
returns table (
  id uuid,
  title text,
  slug text,
  description text,
  formats text[],
  preview_path text,
  price_minor integer,
  currency text,
  updated_at timestamptz,
  status text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  customer uuid := (select auth.uid());
  page_limit integer := least(greatest(coalesce(p_limit, 24), 1), 50);
begin
  if customer is null then
    raise exception 'Authentication required.';
  end if;
  if (p_before_created_at is null) <> (p_before_product_id is null) then
    raise exception 'Both pagination cursor values are required.';
  end if;

  return query
  select p.id, p.title, p.slug, p.description, p.formats,
         p.preview_path, p.price_minor, p.currency, p.updated_at, p.status,
         p.created_at
  from public.products p
  where public.user_can_download_product(p.id, customer)
    and not (p.status = 'published' and p.price_minor = 0)
    and not exists (
      select 1
      from public.orders o
      join public.order_items oi on oi.order_id = o.id
      where o.user_id = customer
        and o.status = 'paid'
        and oi.product_id = p.id
        and oi.refunded_minor < oi.unit_price_minor
    )
    and (
      p_before_created_at is null
      or (p.created_at, p.id) < (p_before_created_at, p_before_product_id)
    )
  order by p.created_at desc, p.id desc
  limit page_limit;
end;
$$;

revoke all on function public.list_my_purchase_products(integer, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.list_my_free_downloads(integer, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.list_my_additional_access_products(integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.list_my_purchase_products(integer, timestamptz, uuid) to authenticated;
grant execute on function public.list_my_free_downloads(integer, timestamptz, uuid) to authenticated;
grant execute on function public.list_my_additional_access_products(integer, timestamptz, uuid) to authenticated;

commit;
