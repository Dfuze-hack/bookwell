begin;

create table public.user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (length(display_name) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger user_profiles_set_updated_at
before update on public.user_profiles
for each row execute function public.set_updated_at();

create index download_events_user_idx
  on public.download_events (user_id, created_at desc);

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
    and p.status = 'published'
    and public.can_download_product(p.id)
  order by p.updated_at desc, p.id
  limit 201;
$$;

alter table public.user_profiles enable row level security;

create policy "Users read own private profile"
  on public.user_profiles for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Users create own private profile"
  on public.user_profiles for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "Users update own private profile"
  on public.user_profiles for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.user_profiles from public, anon, authenticated;
grant select on public.user_profiles to authenticated;
grant insert (user_id, display_name) on public.user_profiles to authenticated;
grant update (display_name) on public.user_profiles to authenticated;

revoke all on function public.list_my_library_products() from public, anon, authenticated;
grant execute on function public.list_my_library_products() to authenticated;

commit;
