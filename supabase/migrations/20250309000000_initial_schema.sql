-- ABOUTME: Initial schema migration for core interview tables
-- ABOUTME: Creates companies, communities, interviews, and interview_responses tables in amplify schema

-- Create the amplify schema if it doesn't exist
create schema if not exists amplify;
-- Enable required extensions
create extension if not exists "uuid-ossp";
-- Companies table
create table if not exists amplify.companies (
    id uuid primary key default extensions.uuid_generate_v4(),
    name text not null,
    slug text unique not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
-- Communities table
create table if not exists amplify.communities (
    id uuid primary key default extensions.uuid_generate_v4(),
    company_id uuid not null references amplify.companies(id) on delete cascade,
    name text not null,
    slug text not null,
    description text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(company_id, slug)
);
-- Interviews table
create table if not exists amplify.interviews (
    id uuid primary key default extensions.uuid_generate_v4(),
    community_id uuid not null references amplify.communities(id) on delete cascade,
    title text,
    status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed', 'error')),
    created_by uuid references auth.users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
-- Interview responses table
create table if not exists amplify.interview_responses (
    id uuid primary key default extensions.uuid_generate_v4(),
    interview_id uuid not null references amplify.interviews(id) on delete cascade,
    question text not null,
    response text,
    ai_analysis jsonb,
    sentiment_score decimal(3,2),
    created_at timestamptz not null default now()
);
-- Create indexes for better query performance
create index if not exists idx_communities_company on amplify.communities(company_id);
create index if not exists idx_interviews_community on amplify.interviews(community_id);
create index if not exists idx_interviews_status on amplify.interviews(status);
create index if not exists idx_interview_responses_interview on amplify.interview_responses(interview_id);
-- Enable Row Level Security
alter table amplify.companies enable row level security;
alter table amplify.communities enable row level security;
alter table amplify.interviews enable row level security;
alter table amplify.interview_responses enable row level security;
-- Create RLS policies for companies
create policy "Companies are viewable by authenticated users"
    on amplify.companies for select
    to authenticated
    using (true);
create policy "Companies are insertable by service role"
    on amplify.companies for insert
    to service_role
    with check (true);
create policy "Companies are updatable by service role"
    on amplify.companies for update
    to service_role
    using (true);
-- Create RLS policies for communities
create policy "Communities are viewable by authenticated users"
    on amplify.communities for select
    to authenticated
    using (true);
create policy "Communities are insertable by service role"
    on amplify.communities for insert
    to service_role
    with check (true);
create policy "Communities are updatable by service role"
    on amplify.communities for update
    to service_role
    using (true);
-- Create RLS policies for interviews
create policy "Interviews are viewable by authenticated users"
    on amplify.interviews for select
    to authenticated
    using (true);
create policy "Interviews are insertable by service role"
    on amplify.interviews for insert
    to service_role
    with check (true);
create policy "Interviews are updatable by service role"
    on amplify.interviews for update
    to service_role
    using (true);
-- Create RLS policies for interview_responses
create policy "Interview responses are viewable by authenticated users"
    on amplify.interview_responses for select
    to authenticated
    using (true);
create policy "Interview responses are insertable by service role"
    on amplify.interview_responses for insert
    to service_role
    with check (true);
create policy "Interview responses are updatable by service role"
    on amplify.interview_responses for update
    to service_role
    using (true);
-- Create updated_at trigger function
create or replace function amplify.handle_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;
-- Add updated_at triggers
create trigger handle_companies_updated_at
    before update on amplify.companies
    for each row
    execute function amplify.handle_updated_at();
create trigger handle_communities_updated_at
    before update on amplify.communities
    for each row
    execute function amplify.handle_updated_at();
create trigger handle_interviews_updated_at
    before update on amplify.interviews
    for each row
    execute function amplify.handle_updated_at();
-- Grant usage on amplify schema to authenticated and anon roles
grant usage on schema amplify to authenticated;
grant usage on schema amplify to anon;
grant usage on schema amplify to service_role;
-- Grant select permissions to authenticated users
grant select on all tables in schema amplify to authenticated;
grant select on all tables in schema amplify to anon;
-- Grant all permissions to service role
grant all on all tables in schema amplify to service_role;
