-- Migration: Setup Invoice OCR Tables and Security Policies

-- 1. Invoices Metadata Table
create table if not exists public.invoices (
    id uuid primary key default uuid_generate_v4(),
    organization_id uuid references public.organizations(id) on delete cascade not null,
    file_name text not null,
    file_path text not null, -- Supabase storage bucket path for 'invoices'
    status text not null default 'PENDING', -- 'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'
    invoice_number text,
    invoice_date date,
    due_date date,
    vendor_name text,
    vendor_address text,
    vendor_tax_id text, -- e.g. GSTIN, VAT ID
    customer_name text,
    customer_address text,
    customer_tax_id text,
    subtotal numeric(15, 2),
    tax_amount numeric(15, 2),
    discount numeric(15, 2),
    total_amount numeric(15, 2),
    currency text default 'INR',
    error_message text,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    completed_at timestamp with time zone
);

-- Enable Row Level Security (RLS)
alter table public.invoices enable row level security;

-- 2. Invoice Individual Line Items
create table if not exists public.invoice_items (
    id uuid primary key default uuid_generate_v4(),
    invoice_id uuid references public.invoices(id) on delete cascade not null,
    description text not null,
    quantity numeric(12, 4) not null default 1.0,
    unit_price numeric(15, 4) not null default 0.0,
    tax_rate numeric(5, 2) default 0.0,
    tax_amount numeric(15, 2) default 0.0,
    total numeric(15, 2) not null default 0.0,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable Row Level Security (RLS)
alter table public.invoice_items enable row level security;

-- 3. Row-Level Security Policies

-- Invoices Policy: Users can perform all operations on invoices belonging to their organization
create policy "Users can access organization invoices" on public.invoices
    for all using (
        organization_id = (select organization_id from public.profiles where id = auth.uid())
    );

-- Invoice Items Policy: Users can perform all operations on items belonging to their organization's invoices
create policy "Users can access organization invoice_items" on public.invoice_items
    for all using (
        exists (
            select 1 from public.invoices
            where invoices.id = invoice_items.invoice_id
            and invoices.organization_id = (select organization_id from public.profiles where id = auth.uid())
        )
    );

-- 4. Storage Bucket Policies (Invoices Bucket)
-- Enable storage policies for authenticated users matching their organization folder path
create policy "Allow authenticated uploads to own organization invoices" on storage.objects
    for insert with check (
        bucket_id = 'invoices' 
        and auth.role() = 'authenticated'
        and name like (select organization_id::text || '/%' from public.profiles where id = auth.uid())
    );

create policy "Allow authenticated selects of own organization invoices" on storage.objects
    for select using (
        bucket_id = 'invoices' 
        and auth.role() = 'authenticated'
        and name like (select organization_id::text || '/%' from public.profiles where id = auth.uid())
    );

create policy "Allow authenticated deletes of own organization invoices" on storage.objects
    for delete using (
        bucket_id = 'invoices' 
        and auth.role() = 'authenticated'
        and name like (select organization_id::text || '/%' from public.profiles where id = auth.uid())
    );
