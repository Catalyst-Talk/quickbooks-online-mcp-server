-- ABOUTME: Adds a durable Retell call mapping to interviews.
-- ABOUTME: Lets webhook persistence resolve interview ids locally when live Retell metadata is unavailable.

alter table amplify.interviews
    add column if not exists retell_call_id text;
create unique index if not exists idx_interviews_retell_call_id
    on amplify.interviews(retell_call_id)
    where retell_call_id is not null;
