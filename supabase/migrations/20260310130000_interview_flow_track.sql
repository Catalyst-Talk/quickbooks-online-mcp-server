-- ABOUTME: Interview flow track schema alignment for VCC milestone #1
-- ABOUTME: Links sessions to interviews, adds response persistence fields, feedback capture

-- ============================================================================
-- 1. Link interview_sessions to interviews table
-- ============================================================================
alter table amplify.interview_sessions
    add column if not exists interview_id uuid references amplify.interviews(id) on delete set null;
-- Add duration tracking
alter table amplify.interview_sessions
    add column if not exists duration_seconds integer;
-- Create index for session -> interview lookups
create index if not exists idx_sessions_interview on amplify.interview_sessions(interview_id);
-- ============================================================================
-- 2. Enhance interview_responses for structured capture
-- ============================================================================
-- Add question_key for deterministic upserts (maps to state machine states)
alter table amplify.interview_responses
    add column if not exists question_key text;
-- Add raw_response for AI-captured content before correction
alter table amplify.interview_responses
    add column if not exists raw_response text;
-- Rename existing 'response' to 'corrected_response' for clarity
-- (Keep 'response' as alias via view or just add corrected_response)
alter table amplify.interview_responses
    add column if not exists corrected_response text;
-- Copy existing response data to corrected_response
update amplify.interview_responses
set corrected_response = response
where corrected_response is null and response is not null;
-- Add session_id for direct linkage to transcript source
alter table amplify.interview_responses
    add column if not exists session_id text;
-- Create unique constraint for upsert operations
create unique index if not exists idx_interview_responses_unique
    on amplify.interview_responses(interview_id, question_key)
    where question_key is not null;
-- Create index for session lookups
create index if not exists idx_interview_responses_session on amplify.interview_responses(session_id);
-- ============================================================================
-- 3. Add feedback capture fields to interview_sessions
-- ============================================================================
-- Experience rating (1-10 scale)
alter table amplify.interview_sessions
    add column if not exists rating integer check (rating >= 1 and rating <= 10);
-- Open-ended feedback
alter table amplify.interview_sessions
    add column if not exists feedback_text text;
-- Feedback input mode (voice or text)
alter table amplify.interview_sessions
    add column if not exists feedback_mode text check (feedback_mode in ('voice', 'text'));
-- Feedback timestamp
alter table amplify.interview_sessions
    add column if not exists feedback_at timestamptz;
-- ============================================================================
-- 4. Fix interview_transcripts table (align with chunk-based schema)
-- ============================================================================
-- This migration already ran but ensure columns exist for safety
-- The 20260310125000 migration changed the schema, this ensures consistency

-- Ensure session_id is text (not uuid FK, since sessions use uuid but we want flexibility)
-- This is already handled by the previous migration, just ensuring index exists
create index if not exists idx_transcripts_session_timestamp on amplify.interview_transcripts(session_id, timestamp);
-- ============================================================================
-- 5. RLS policies for new columns (inherit existing table policies)
-- ============================================================================
-- No new policies needed - existing table policies cover new columns

-- ============================================================================
-- 6. Add helper function for session completion
-- ============================================================================
create or replace function amplify.complete_interview_session(
    p_session_id uuid,
    p_duration_seconds integer default null,
    p_rating integer default null,
    p_feedback text default null,
    p_feedback_mode text default null
) returns void as $$
begin
    update amplify.interview_sessions
    set
        status = 'completed',
        completed_at = now(),
        duration_seconds = coalesce(p_duration_seconds, 
            extract(epoch from (now() - started_at))::integer),
        rating = p_rating,
        feedback_text = p_feedback,
        feedback_mode = p_feedback_mode,
        feedback_at = case when p_feedback is not null then now() else null end,
        updated_at = now()
    where id = p_session_id;
end;
$$ language plpgsql security definer;
-- Grant execute permission
grant execute on function amplify.complete_interview_session(uuid, integer, integer, text, text) to service_role;
-- ============================================================================
-- 7. Add helper function for upserting interview responses
-- ============================================================================
create or replace function amplify.upsert_interview_response(
    p_interview_id uuid,
    p_question_key text,
    p_question text,
    p_raw_response text default null,
    p_corrected_response text default null,
    p_session_id text default null
) returns uuid as $$
declare
    v_response_id uuid;
begin
    insert into amplify.interview_responses (
        interview_id,
        question_key,
        question,
        raw_response,
        corrected_response,
        session_id
    ) values (
        p_interview_id,
        p_question_key,
        p_question,
        p_raw_response,
        p_corrected_response,
        p_session_id
    )
    on conflict (interview_id, question_key) where question_key is not null
    do update set
        question = excluded.question,
        raw_response = excluded.raw_response,
        corrected_response = coalesce(excluded.corrected_response, amplify.interview_responses.corrected_response),
        session_id = excluded.session_id,
        created_at = now()
    returning id into v_response_id;
    
    return v_response_id;
end;
$$ language plpgsql security definer;
-- Grant execute permission
grant execute on function amplify.upsert_interview_response(uuid, text, text, text, text, text) to service_role;
