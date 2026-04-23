-- ABOUTME: Session progress authority schema for VCC-1485 Task 1
-- ABOUTME: Adds state tracking to interview_sessions and creates authority RPCs

-- ============================================================================
-- 1. Add progress tracking columns to interview_sessions
-- ============================================================================
alter table amplify.interview_sessions
    add column if not exists current_state text,
    add column if not exists completed_states jsonb default '[]'::jsonb,
    add column if not exists last_capture_sequence integer default 0;
-- ============================================================================
-- 2. Create index for active session lookup by interview_id
-- ============================================================================
create index if not exists idx_sessions_interview_active
    on amplify.interview_sessions(interview_id)
    where status = 'in_progress';
-- ============================================================================
-- 3. RPC: resolve_or_create_active_session
-- ============================================================================
create or replace function amplify.resolve_or_create_active_session(
    p_interview_id uuid,
    p_community_id uuid
) returns uuid as $$
declare
    v_session_id uuid;
begin
    -- Try to find existing active session for this interview
    select id into v_session_id
    from amplify.interview_sessions
    where interview_id = p_interview_id
      and status = 'in_progress'
    order by created_at desc
    limit 1;

    -- If no active session exists, create one
    if v_session_id is null then
        insert into amplify.interview_sessions (
            interview_id,
            community_id,
            status,
            current_state,
            completed_states,
            last_capture_sequence,
            started_at
        ) values (
            p_interview_id,
            p_community_id,
            'in_progress',
            'idle',
            '[]'::jsonb,
            0,
            now()
        ) returning id into v_session_id;
    end if;

    return v_session_id;
end;
$$ language plpgsql security definer;
grant execute on function amplify.resolve_or_create_active_session(uuid, uuid) to service_role;
-- ============================================================================
-- 4. RPC: update_session_progress_authority
-- ============================================================================
create or replace function amplify.update_session_progress_authority(
    p_session_id uuid,
    p_current_state text,
    p_completed_states text,
    p_capture_sequence integer
) returns void as $$
begin
    -- Only update if sequence is greater than last_capture_sequence
    -- This prevents duplicate/out-of-order updates from rewinding progress
    update amplify.interview_sessions
    set
        current_state = p_current_state,
        completed_states = p_completed_states::jsonb,
        last_capture_sequence = p_capture_sequence,
        updated_at = now()
    where id = p_session_id
      and (
          last_capture_sequence is null
          or p_capture_sequence > last_capture_sequence
      );
end;
$$ language plpgsql security definer;
grant execute on function amplify.update_session_progress_authority(uuid, text, text, integer) to service_role;
