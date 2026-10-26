begin;

alter table public.products
  add column if not exists author_name text,
  add column if not exists subtitle text,
  add column if not exists publication_year integer,
  add column if not exists edition text,
  add column if not exists isbn text,
  add column if not exists page_count integer;

alter table public.products drop constraint if exists products_author_name_len;
alter table public.products add constraint products_author_name_len
  check (author_name is null or length(trim(author_name)) between 1 and 160);

alter table public.products drop constraint if exists products_subtitle_len;
alter table public.products add constraint products_subtitle_len
  check (subtitle is null or length(trim(subtitle)) between 1 and 200);

alter table public.products drop constraint if exists products_publication_year_range;
alter table public.products add constraint products_publication_year_range
  check (publication_year is null or (publication_year >= 1000 and publication_year <= 2100));

alter table public.products drop constraint if exists products_edition_len;
alter table public.products add constraint products_edition_len
  check (edition is null or length(trim(edition)) between 1 and 80);

alter table public.products drop constraint if exists products_isbn_shape;
alter table public.products add constraint products_isbn_shape
  check (
    isbn is null
    or length(replace(replace(isbn, '-', ''), ' ', '')) in (10, 13)
  );

alter table public.products drop constraint if exists products_page_count_range;
alter table public.products add constraint products_page_count_range
  check (page_count is null or (page_count >= 1 and page_count <= 100000));

drop index if exists public.products_search_idx;
alter table public.products drop column if exists search_document;
drop function if exists public.product_search_document(text, text, text[]);

create function public.product_search_document(
  product_title text,
  product_description text,
  product_tags text[],
  product_author text default '',
  product_subtitle text default ''
)
returns tsvector
language sql
immutable
set search_path = ''
as $$
  select to_tsvector(
    'simple',
    coalesce(product_title, '') || ' ' || coalesce(product_description, '') || ' ' ||
    coalesce(array_to_string(product_tags, ' '), '') || ' ' ||
    coalesce(product_author, '') || ' ' || coalesce(product_subtitle, '')
  );
$$;

alter table public.products add column search_document tsvector generated always as (
  public.product_search_document(title, description, tags, author_name, subtitle)
) stored;
create index products_search_idx on public.products using gin (search_document);

revoke all on public.products from public, anon, authenticated;
grant select (
  id, creator_id, category_id, title, slug, description, tags, formats,
  license, preview_path, price_minor, currency, language, included_with_premium,
  status, updated_at, created_at, author_name, subtitle, publication_year,
  edition, isbn, page_count
) on public.products to anon, authenticated;
grant insert, update, delete on public.products to authenticated;

create or replace function public.creator_can_manage_product_object(
  target_bucket text,
  object_name text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.has_role('creator')
    and target_bucket in ('product-files', 'product-previews')
    and (
      (
        target_bucket = 'product-files'
        and object_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(pdf|zip|docx|pptx|xlsx)$'
      )
      or (
        target_bucket = 'product-previews'
        and object_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(png|jpg|webp)$'
      )
    )
    and not exists (
      select 1
      from public.products p
      where p.id = ((storage.foldername(object_name))[1])::uuid
        and p.creator_id is distinct from (select auth.uid())
    );
$$;

revoke all on function public.creator_can_manage_product_object(text, text)
  from public, anon, authenticated;
grant execute on function public.creator_can_manage_product_object(text, text)
  to authenticated;

drop policy if exists "Creators upload own product files" on storage.objects;
create policy "Creators upload own product files" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'product-files'
  and public.creator_can_manage_product_object('product-files', name)
);

drop policy if exists "Creators update own product files" on storage.objects;
create policy "Creators update own product files" on storage.objects
for update to authenticated
using (
  bucket_id = 'product-files'
  and public.creator_can_manage_product_object('product-files', name)
)
with check (
  bucket_id = 'product-files'
  and public.creator_can_manage_product_object('product-files', name)
);

drop policy if exists "Creators delete own product files" on storage.objects;
create policy "Creators delete own product files" on storage.objects
for delete to authenticated
using (
  bucket_id = 'product-files'
  and public.creator_can_manage_product_object('product-files', name)
);

drop policy if exists "Creators upload own product previews" on storage.objects;
create policy "Creators upload own product previews" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'product-previews'
  and public.creator_can_manage_product_object('product-previews', name)
);

drop policy if exists "Creators update own product previews" on storage.objects;
create policy "Creators update own product previews" on storage.objects
for update to authenticated
using (
  bucket_id = 'product-previews'
  and public.creator_can_manage_product_object('product-previews', name)
)
with check (
  bucket_id = 'product-previews'
  and public.creator_can_manage_product_object('product-previews', name)
);

drop policy if exists "Creators delete own product previews" on storage.objects;
create policy "Creators delete own product previews" on storage.objects
for delete to authenticated
using (
  bucket_id = 'product-previews'
  and public.creator_can_manage_product_object('product-previews', name)
);

drop policy if exists "Creators read own product previews" on storage.objects;
create policy "Creators read own product previews" on storage.objects
for select to authenticated
using (
  bucket_id = 'product-previews'
  and public.has_role('creator')
  and exists (
    select 1
    from public.products p
    where p.preview_path = name
      and p.creator_id = (select auth.uid())
  )
);

drop function if exists public.admin_list_products();
create function public.admin_list_products()
returns table (
  id uuid, creator_id uuid, category_id uuid, title text, slug text,
  description text, tags text[], formats text[], license text,
  preview_path text, file_path text, price_minor integer, currency text, language text,
  included_with_premium boolean, status text, updated_at timestamptz,
  author_name text, subtitle text, publication_year integer, edition text,
  isbn text, page_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.creator_id, p.category_id, p.title, p.slug, p.description,
         p.tags, p.formats, p.license, p.preview_path, p.file_path,
         p.price_minor, p.currency, p.language, p.included_with_premium, p.status, p.updated_at,
         p.author_name, p.subtitle, p.publication_year, p.edition, p.isbn, p.page_count
  from public.products p
  where public.has_role('admin')
     or (public.has_role('creator') and p.creator_id = (select auth.uid()))
  order by p.updated_at desc
  limit 500;
$$;

revoke all on function public.admin_list_products() from public, anon, authenticated;
grant execute on function public.admin_list_products() to authenticated;

drop function if exists public.search_public_products(text, text, text, text, text, text, integer, integer, integer, integer, text);

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
  category_name text, category_slug text, creator_name text,
  author_name text, subtitle text, publication_year integer, edition text,
  isbn text, page_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.title, p.slug, p.description, p.tags, p.formats, p.license,
         p.preview_path,
         p.price_minor, p.currency, p.language, p.included_with_premium,
         p.updated_at, p.created_at, c.name, c.slug,
         coalesce(cp.display_name, 'BookWell'),
         p.author_name, p.subtitle, p.publication_year, p.edition, p.isbn, p.page_count
  from public.products p
  join public.categories c on c.id = p.category_id
  left join public.creator_profiles cp on cp.user_id = p.creator_id
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
          array_to_string(p.tags, ' ') || ' ' || c.name || ' ' || coalesce(p.language, '') || ' ' ||
          coalesce(p.author_name, '') || ' ' || coalesce(p.subtitle, '')
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

drop function if exists public.public_product_by_slug(text);
create function public.public_product_by_slug(p_slug text)
returns table (
  id uuid, title text, slug text, description text, tags text[], formats text[],
  license text, preview_path text, price_minor integer, currency text, language text,
  included_with_premium boolean, updated_at timestamptz, created_at timestamptz,
  category_name text, category_slug text, creator_name text,
  author_name text, subtitle text, publication_year integer, edition text,
  isbn text, page_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.title, p.slug, p.description, p.tags, p.formats, p.license,
         p.preview_path,
         p.price_minor, p.currency, p.language, p.included_with_premium,
         p.updated_at, p.created_at, c.name, c.slug,
         coalesce(cp.display_name, 'BookWell'),
         p.author_name, p.subtitle, p.publication_year, p.edition, p.isbn, p.page_count
  from public.products p
  join public.categories c on c.id = p.category_id
  left join public.creator_profiles cp on cp.user_id = p.creator_id
  where p.slug = p_slug and p.status = 'published' and c.is_active
  limit 1;
$$;

revoke all on function public.public_product_by_slug(text) from public, anon, authenticated;
grant execute on function public.public_product_by_slug(text) to anon, authenticated;

drop function if exists public.related_public_products(uuid, integer);
create function public.related_public_products(target_product uuid, p_limit integer default 4)
returns table (
  id uuid, title text, slug text, description text, tags text[], formats text[],
  license text, preview_path text, price_minor integer, currency text, language text,
  included_with_premium boolean, updated_at timestamptz, created_at timestamptz,
  category_name text, category_slug text, creator_name text,
  author_name text, subtitle text, publication_year integer, edition text,
  isbn text, page_count integer
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
         p.preview_path,
         p.price_minor, p.currency, p.language, p.included_with_premium,
         p.updated_at, p.created_at, c.name, c.slug,
         coalesce(cp.display_name, 'BookWell'),
         p.author_name, p.subtitle, p.publication_year, p.edition, p.isbn, p.page_count
  from public.products p
  join public.categories c on c.id = p.category_id
  left join public.creator_profiles cp on cp.user_id = p.creator_id
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
