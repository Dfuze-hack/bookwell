begin;

drop function public.search_public_products(text, text, text, text, text, integer, integer, integer, integer, text);
create function public.search_public_products(
  p_search text default null,
  p_category text default null,
  p_language text default null,
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
  included_with_premium boolean, updated_at timestamptz, created_at timestamptz,
  category_name text, category_slug text, creator_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.title, p.slug, p.description, p.tags, p.formats, p.license,
         case when p.price_minor = 0 then p.preview_path else null end,
         p.price_minor, p.currency, p.language, p.included_with_premium,
         p.updated_at, p.created_at, c.name, c.slug, cp.display_name
  from public.products p
  join public.categories c on c.id = p.category_id
  join public.creator_profiles cp on cp.user_id = p.creator_id
  where p.status = 'published'
    and c.is_active
    and (
      p_search is null
      or p.search_document @@ websearch_to_tsquery('simple', p_search)
      or to_tsvector('simple', c.name) @@ websearch_to_tsquery('simple', p_search)
      or coalesce(p.language, '') ilike '%' || p_search || '%'
    )
    and (p_category is null or c.slug = p_category)
    and (p_language is null or lower(p.language) = lower(p_language))
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
    case when p_sort = 'relevance' and p_search is not null
      then ts_rank(
        to_tsvector('simple',
          coalesce(p.title, '') || ' ' || coalesce(p.description, '') || ' ' ||
          array_to_string(p.tags, ' ') || ' ' || c.name || ' ' || coalesce(p.language, '')
        ),
        websearch_to_tsquery('simple', p_search)
      ) end desc,
    case when p_sort not in ('title', 'price_asc', 'price_desc')
      or (p_sort = 'relevance' and p_search is null)
      then p.created_at end desc,
    p.id
  limit least(greatest(coalesce(p_limit, 12), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.search_public_products(text, text, text, text, text, text, integer, integer, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.search_public_products(text, text, text, text, text, text, integer, integer, integer, integer, text)
  to anon, authenticated;

drop function public.public_product_by_slug(text);
create function public.public_product_by_slug(p_slug text)
returns table (
  id uuid, title text, slug text, description text, tags text[], formats text[],
  license text, preview_path text, price_minor integer, currency text, language text,
  included_with_premium boolean, updated_at timestamptz, created_at timestamptz,
  category_name text, category_slug text, creator_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.title, p.slug, p.description, p.tags, p.formats, p.license,
         case when p.price_minor = 0 then p.preview_path else null end,
         p.price_minor, p.currency, p.language, p.included_with_premium,
         p.updated_at, p.created_at, c.name, c.slug, cp.display_name
  from public.products p
  join public.categories c on c.id = p.category_id
  join public.creator_profiles cp on cp.user_id = p.creator_id
  where p.slug = p_slug and p.status = 'published' and c.is_active
  limit 1;
$$;

revoke all on function public.public_product_by_slug(text) from public, anon, authenticated;
grant execute on function public.public_product_by_slug(text) to anon, authenticated;

create function public.browse_public_categories()
returns table (name text, slug text, product_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select c.name, c.slug, count(p.id)
  from public.categories c
  join public.products p on p.category_id = c.id and p.status = 'published'
  where c.is_active
  group by c.id, c.name, c.slug
  order by count(p.id) desc, c.name;
$$;

revoke all on function public.browse_public_categories() from public, anon, authenticated;
grant execute on function public.browse_public_categories() to anon, authenticated;

create function public.browse_public_languages()
returns table (language text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct trim(p.language)
  from public.products p
  join public.categories c on c.id = p.category_id
  where p.status = 'published'
    and c.is_active
    and nullif(trim(p.language), '') is not null
  order by trim(p.language);
$$;

revoke all on function public.browse_public_languages() from public, anon, authenticated;
grant execute on function public.browse_public_languages() to anon, authenticated;

create function public.related_public_products(target_product uuid, p_limit integer default 4)
returns table (
  id uuid, title text, slug text, description text, tags text[], formats text[],
  license text, preview_path text, price_minor integer, currency text, language text,
  included_with_premium boolean, updated_at timestamptz, created_at timestamptz,
  category_name text, category_slug text, creator_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  with anchor as (
    select p.category_id, p.language, p.formats, p.tags
    from public.products p
    join public.categories c on c.id = p.category_id
    where p.id = target_product and p.status = 'published' and c.is_active
  )
  select p.id, p.title, p.slug, p.description, p.tags, p.formats, p.license,
         case when p.price_minor = 0 then p.preview_path else null end,
         p.price_minor, p.currency, p.language, p.included_with_premium,
         p.updated_at, p.created_at, c.name, c.slug, cp.display_name
  from public.products p
  join public.categories c on c.id = p.category_id
  join public.creator_profiles cp on cp.user_id = p.creator_id
  cross join anchor a
  where p.id <> target_product
    and p.status = 'published'
    and c.is_active
    and (
      p.category_id = a.category_id
      or (a.language is not null and lower(p.language) = lower(a.language))
      or p.formats && a.formats
      or exists (
        select 1
        from unnest(p.tags) as product_tag(tag)
        join unnest(a.tags) as anchor_tag(tag)
          on lower(product_tag.tag) = lower(anchor_tag.tag)
      )
    )
  order by
    (case when p.category_id = a.category_id then 10 else 0 end
      + case when a.language is not null and lower(p.language) = lower(a.language) then 4 else 0 end
      + case when p.formats && a.formats then 2 else 0 end
      + (select count(*) from unnest(p.tags) as product_tag(tag)
         where exists (
           select 1 from unnest(a.tags) as anchor_tag(tag)
           where lower(anchor_tag.tag) = lower(product_tag.tag)
         ))) desc,
    p.created_at desc,
    p.id
  limit least(greatest(coalesce(p_limit, 4), 1), 8);
$$;

revoke all on function public.related_public_products(uuid, integer) from public, anon, authenticated;
grant execute on function public.related_public_products(uuid, integer) to anon, authenticated;

commit;
