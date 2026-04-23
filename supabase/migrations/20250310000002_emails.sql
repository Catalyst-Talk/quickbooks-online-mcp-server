-- ABOUTME: Migration for interview invite email tracking
-- ABOUTME: Creates amplify.emails table with delivery/open tracking fields

create table if not exists amplify.emails (
    id uuid primary key default extensions.uuid_generate_v4(),
    recipient_email text not null,
    interview_id uuid not null references amplify.interviews(id) on delete cascade,
    provider text,
    provider_message_id text,
    status text not null default 'pending' check (status in ('pending', 'sent', 'delivered', 'opened', 'failed')),
    error_message text,
    retry_count integer not null default 0,
    sent_at timestamptz,
    delivered_at timestamptz,
    opened_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_emails_interview_id on amplify.emails(interview_id);
create index if not exists idx_emails_status on amplify.emails(status);
create index if not exists idx_emails_provider_message_id on amplify.emails(provider_message_id);
alter table amplify.emails enable row level security;
create policy "Emails are viewable by authenticated users"
    on amplify.emails for select
    to authenticated
    using (true);
create policy "Emails are insertable by service role"
    on amplify.emails for insert
    to service_role
    with check (true);
create policy "Emails are updatable by service role"
    on amplify.emails for update
    to service_role
    using (true);
create trigger handle_emails_updated_at
    before update on amplify.emails
    for each row
    execute function amplify.handle_updated_at();
grant select on amplify.emails to authenticated;
grant select on amplify.emails to anon;
grant all on amplify.emails to service_role;
