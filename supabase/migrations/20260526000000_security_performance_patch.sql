-- Migration: Security, Performance, and Bank Constraints Patches

-- 1. Security Policies for 'statements' Storage Bucket
-- Ensure the bucket exists (usually created via dashboard, but we patch it just in case)
insert into storage.buckets (id, name, public)
values ('statements', 'statements', false)
on conflict (id) do nothing;

create policy "Allow authenticated uploads to own organization statements" on storage.objects
    for insert with check (
        bucket_id = 'statements'
        and auth.role() = 'authenticated'
        and name like (select organization_id::text || '/%' from public.profiles where id = auth.uid())
    );

create policy "Allow authenticated selects of own organization statements" on storage.objects
    for select using (
        bucket_id = 'statements'
        and auth.role() = 'authenticated'
        and name like (select organization_id::text || '/%' from public.profiles where id = auth.uid())
    );

create policy "Allow authenticated deletes of own organization statements" on storage.objects
    for delete using (
        bucket_id = 'statements'
        and auth.role() = 'authenticated'
        and name like (select organization_id::text || '/%' from public.profiles where id = auth.uid())
    );


-- 2. Performance: Indexes for Foreign Key RLS Policy lookups
create index if not exists idx_profiles_organization_id on public.profiles(organization_id);
create index if not exists idx_parsing_jobs_organization_id on public.parsing_jobs(organization_id);
create index if not exists idx_transactions_job_id on public.transactions(job_id);
create index if not exists idx_transactions_organization_id on public.transactions(organization_id);
create index if not exists idx_invoices_organization_id on public.invoices(organization_id);
create index if not exists idx_invoice_items_invoice_id on public.invoice_items(invoice_id);
