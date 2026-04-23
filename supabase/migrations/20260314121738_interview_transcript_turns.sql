-- ABOUTME: Interview transcript turns table for append-only canonical turn storage
-- ABOUTME: Creates amplify.interview_transcript_turns with sequence-based turn persistence and idempotent inserts

do $$
begin
    if to_regclass('amplify.interview_transcript_turns') is null then
        create table amplify.interview_transcript_turns (
            id uuid primary key default extensions.uuid_generate_v4(),
            session_id uuid not null references amplify.interview_sessions(id) on delete cascade,
            sequence integer not null,
            speaker text not null,
            state text,
            turn_text text not null,
            source text not null,
            captured_at timestamptz not null default now(),
            payload jsonb,
            created_at timestamptz not null default now(),
            constraint interview_transcript_turns_session_id_sequence_key unique (session_id, sequence)
        );
    end if;
end $$;
-- Create index for fast lookups by session and sequence
create index if not exists idx_interview_transcript_turns_session_sequence on amplify.interview_transcript_turns(session_id, sequence);
-- Create index for fast lookups by captured_at
create index if not exists idx_interview_transcript_turns_captured_at on amplify.interview_transcript_turns(captured_at);
-- Enable Row Level Security
alter table amplify.interview_transcript_turns enable row level security;
-- Create RLS policies for interview_transcript_turns
drop policy if exists "Interview transcript turns are viewable by authenticated users" on amplify.interview_transcript_turns;
create policy "Interview transcript turns are viewable by authenticated users"
    on amplify.interview_transcript_turns for select
    to authenticated
    using (true);
drop policy if exists "Interview transcript turns are insertable by service role" on amplify.interview_transcript_turns;
create policy "Interview transcript turns are insertable by service role"
    on amplify.interview_transcript_turns for insert
    to service_role
    with check (true);
-- Grant permissions to roles
grant select on amplify.interview_transcript_turns to authenticated;
grant all on amplify.interview_transcript_turns to service_role;
