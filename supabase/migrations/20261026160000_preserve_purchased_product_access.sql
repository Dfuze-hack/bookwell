begin;

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
    where p.id = target_product and (
      (p.status = 'published' and p.price_minor = 0)
      or (
        target_user is not null and (
          (
            p.status = 'published' and (
              p.creator_id = target_user
              or exists (
                select 1 from public.user_roles r
                where r.user_id = target_user and r.role = 'admin'
              )
            )
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
        )
      )
    )
  );
$$;

revoke all on function public.user_can_download_product(uuid, uuid) from public, anon, authenticated;
grant execute on function public.user_can_download_product(uuid, uuid) to service_role;

create or replace function public.get_authorized_download_path(
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
    and public.user_can_download_product(p.id, target_user);
$$;

revoke all on function public.get_authorized_download_path(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_authorized_download_path(uuid, uuid) to service_role;

create or replace function public.list_my_library_products()
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
  status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.title, p.slug, p.description, p.formats,
         p.preview_path, p.price_minor, p.currency, p.updated_at, p.status
  from public.products p
  where (select auth.uid()) is not null
    and public.can_download_product(p.id)
  order by p.updated_at desc, p.id
  limit 201;
$$;

revoke all on function public.list_my_library_products() from public, anon, authenticated;
grant execute on function public.list_my_library_products() to authenticated;

commit;
