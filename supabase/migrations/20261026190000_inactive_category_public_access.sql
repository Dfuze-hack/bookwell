begin;

create or replace function public.product_is_publicly_available(target_product uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.products p
    join public.categories c on c.id = p.category_id
    where p.id = target_product
      and p.status = 'published'
      and c.is_active
  );
$$;

revoke all on function public.product_is_publicly_available(uuid) from public, anon, authenticated;
grant execute on function public.product_is_publicly_available(uuid) to anon, authenticated, service_role;

drop policy if exists "Published products are public" on public.products;
create policy "Published products in active categories are public" on public.products
for select to anon, authenticated using (
  public.product_is_publicly_available(id)
  or creator_id = (select auth.uid())
  or public.has_role('admin')
);

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
      (public.product_is_publicly_available(p.id) and p.price_minor = 0)
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

create or replace function public.creator_profile_is_public(target_creator uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.products p
    where p.creator_id = target_creator
      and public.product_is_publicly_available(p.id)
  );
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
    and public.product_is_publicly_available(p.id)
  order by r.created_at desc
  limit 100;
$$;

commit;
