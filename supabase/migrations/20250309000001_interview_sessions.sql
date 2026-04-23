-- ABOUTME: Interview session tables migration
-- ABOUTME: Creates interview_sessions, interview_transcripts, and interview_recordings tables in amplify schema

-- Interview sessions table
create table if not exists amplify.interview_sessions (
    id uuid primary key default extensions.uuid_generate_v4(),
    community_id uuid not null references amplify.communities(id) on delete cascade,
    status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed', 'error')),
    started_at timestamptz,
    completed_at timestamptz,
    error_message text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
-- Interview transcripts table
create table if not exists amplify.interview_transcripts (
    id uuid primary key default extensions.uuid_generate_v4(),
    session_id uuid not null references amplify.interview_sessions(id) on delete cascade,
    raw_content text,
    corrected_content text,
    language text default 'en',
    word_count integer default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
-- Interview recordings table
create table if not exists amplify.interview_recordings (
    id uuid primary key default extensions.uuid_generate_v4(),
    session_id uuid not null references amplify.interview_sessions(id) on delete cascade,
    storage_path text not null,
    file_size bigint,
    duration_seconds integer,
    format text default 'webm',
    metadata jsonb default '{}'::jsonb,
    created_at timestamptz not null default now()
);
-- Create indexes for session tables
create index if not exists idx_sessions_status on amplify.interview_sessions(status);
create index if not exists idx_sessions_community on amplify.interview_sessions(community_id);
create index if not exists idx_sessions_created_at on amplify.interview_sessions(created_at);
create index if not exists idx_transcripts_session on amplify.interview_transcripts(session_id);
create index if not exists idx_recordings_session on amplify.interview_recordings(session_id);
-- Enable Row Level Security
alter table amplify.interview_sessions enable row level security;
alter table amplify.interview_transcripts enable row level security;
alter table amplify.interview_recordings enable row level security;
-- Create RLS policies for interview_sessions
create policy "Interview sessions are viewable by authenticated users"
    on amplify.interview_sessions for select
    to authenticated
    using (true);
create policy "Interview sessions are insertable by service role"
    on amplify.interview_sessions for insert
    to service_role
    with check (true);
create policy "Interview sessions are updatable by service role"
    on amplify.interview_sessions for update
    to service_role
    using (true);
-- Create RLS policies for interview_transcripts
create policy "Interview transcripts are viewable by authenticated users"
    on amplify.interview_transcripts for select
    to authenticated
    using (true);
create policy "Interview transcripts are insertable by service role"
    on amplify.interview_transcripts for insert
    to service_role
    with check (true);
create policy "Interview transcripts are updatable by service role"
    on amplify.interview_transcripts for update
    to service_role
    using (true);
-- Create RLS policies for interview_recordings
create policy "Interview recordings are viewable by authenticated users"
    on amplify.interview_recordings for select
    to authenticated
    using (true);
create policy "Interview recordings are insertable by service role"
    on amplify.interview_recordings for insert
    to service_role
    with check (true);
create policy "Interview recordings are updatable by service role"
    on amplify.interview_recordings for update
    to service_role
    using (true);
-- Add updated_at triggers for session tables
create trigger handle_interview_sessions_updated_at
    before update on amplify.interview_sessions
    for each row
    execute function amplify.handle_updated_at();
create trigger handle_interview_transcripts_updated_at
    before update on amplify.interview_transcripts
    for each row
    execute function amplify.handle_updated_at();
-- Grant permissions to roles
grant select on amplify.interview_sessions to authenticated;
grant select on amplify.interview_transcripts to authenticated;
grant select on amplify.interview_recordings to authenticated;
grant all on amplify.interview_sessions to service_role;
grant all on amplify.interview_transcripts to service_role;
grant all on amplify.interview_recordings to service_role;
