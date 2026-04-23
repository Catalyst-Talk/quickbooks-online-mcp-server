-- ABOUTME: Interview transcripts table for real-time streaming session storage
-- ABOUTME: Creates amplify.interview_transcripts with session-based transcript chunk persistence

do $$
begin
    if to_regclass('amplify.interview_transcripts') is null then
        create table amplify.interview_transcripts (
            id uuid primary key default extensions.uuid_generate_v4(),
            session_id text not null,
            chunk_text text not null,
            speaker text not null,
            timestamp timestamptz not null,
            created_at timestamptz not null default now()
        );
    elsif not exists (
        select 1
        from information_schema.columns
        where table_schema = 'amplify'
          and table_name = 'interview_transcripts'
          and column_name = 'chunk_text'
    ) then
        drop trigger if exists handle_interview_transcripts_updated_at on amplify.interview_transcripts;

        alter table amplify.interview_transcripts
            drop constraint if exists interview_transcripts_session_id_fkey;

        alter table amplify.interview_transcripts
            alter column session_id type text using session_id::text;

        alter table amplify.interview_transcripts
            add column chunk_text text,
            add column speaker text,
            add column timestamp timestamptz;

        update amplify.interview_transcripts
        set
            chunk_text = coalesce(corrected_content, raw_content, ''),
            speaker = 'agent',
            timestamp = created_at
        where chunk_text is null
           or speaker is null
           or timestamp is null;

        alter table amplify.interview_transcripts
            alter column chunk_text set not null,
            alter column speaker set not null,
            alter column timestamp set not null;

        alter table amplify.interview_transcripts
            drop column if exists raw_content,
            drop column if exists corrected_content,
            drop column if exists language,
            drop column if exists word_count,
            drop column if exists updated_at;
    end if;
end $$;
-- Create index for fast lookups by session and timestamp
create index if not exists idx_interview_transcripts_session_timestamp on amplify.interview_transcripts(session_id, timestamp);
-- Enable Row Level Security
alter table amplify.interview_transcripts enable row level security;
-- Create RLS policies for interview_transcripts
drop policy if exists "Interview transcripts are viewable by authenticated users" on amplify.interview_transcripts;
create policy "Interview transcripts are viewable by authenticated users"
    on amplify.interview_transcripts for select
    to authenticated
    using (true);
drop policy if exists "Interview transcripts are insertable by service role" on amplify.interview_transcripts;
create policy "Interview transcripts are insertable by service role"
    on amplify.interview_transcripts for insert
    to service_role
    with check (true);
drop policy if exists "Interview transcripts are updatable by service role" on amplify.interview_transcripts;
create policy "Interview transcripts are updatable by service role"
    on amplify.interview_transcripts for update
    to service_role
    using (true);
-- Grant permissions to roles
grant select on amplify.interview_transcripts to authenticated;
grant all on amplify.interview_transcripts to service_role;
