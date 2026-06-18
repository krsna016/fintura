-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- 1. Organizations (Tenants)
create table public.organizations (
    id uuid primary key default uuid_generate_v4(),
    name text not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS on Organizations
alter table public.organizations enable row level security;

-- 2. Profiles (Linked to Supabase Auth.users)
create table public.profiles (
    id uuid primary key references auth.users on delete cascade,
    organization_id uuid references public.organizations(id) on delete set null,
    full_name text,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS on Profiles
alter table public.profiles enable row level security;

-- 3. Parsing Jobs
create table public.parsing_jobs (
    id uuid primary key default uuid_generate_v4(),
    organization_id uuid references public.organizations(id) on delete cascade not null,
    file_name text not null,
    file_path text not null, -- Supabase storage bucket path
    bank_detected text, -- 'ICICI' | 'YES_BANK' | 'IDFC_FIRST'
    status text not null default 'PENDING', -- 'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'
    total_rows integer default 0,
    error_message text,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    completed_at timestamp with time zone
);

-- Enable RLS on Parsing Jobs
alter table public.parsing_jobs enable row level security;

-- 4. Transactions (Extracted Rows)
create table public.transactions (
    id uuid primary key default uuid_generate_v4(),
    job_id uuid references public.parsing_jobs(id) on delete cascade not null,
    organization_id uuid references public.organizations(id) on delete cascade not null,
    transaction_date timestamp not null,
    raw_narration text not null,
    cleaned_party text,
    transaction_mode text, -- 'UPI', 'IMPS', 'NEFT', 'RTGS', 'CASH', 'CHEQUE', 'CARD', 'CHARGES'
    type text not null check (type in ('CR', 'DR')),
    amount numeric(15, 2) not null,
    running_balance numeric(15, 2) not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS on Transactions
alter table public.transactions enable row level security;

-- 5. Row-Level Security Policies (RLS)

-- Organizations Policy: Users can only view their own organization
create policy "Users can view their organization" on public.organizations
    for select using (
        exists (
            select 1 from public.profiles 
            where profiles.id = auth.uid() 
            and profiles.organization_id = organizations.id
        )
    );

-- Profiles Policy: Users can only read/edit their own profile
create policy "Users can view own profile" on public.profiles
    for select using (auth.uid() = id);

create policy "Users can update own profile" on public.profiles
    for update using (auth.uid() = id);

-- Parsing Jobs Policy: Users can only access jobs belonging to their organization
create policy "Users can access organization parsing jobs" on public.parsing_jobs
    for all using (
        organization_id = (select organization_id from public.profiles where id = auth.uid())
    );

-- Transactions Policy: Users can only access transactions belonging to their organization
create policy "Users can access organization transactions" on public.transactions
    for all using (
        organization_id = (select organization_id from public.profiles where id = auth.uid())
    );

-- 6. Auth Trigger: Automate profile creation on user signup
create or replace function public.handle_new_user()
returns trigger as $$
declare
    new_org_id uuid;
begin
    -- Create default organization for new signups
    insert into public.organizations (name)
    values (concat(split_part(new.email, '@', 1), ' Workspace'))
    returning id into new_org_id;

    -- Create user profile linked to the new org
    insert into public.profiles (id, organization_id, full_name)
    values (
        new.id, 
        new_org_id, 
        coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
    );
    
    return new;
end;
$$ language plpgsql security definer set search_path = public;

-- Bind the trigger
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.handle_new_user();
