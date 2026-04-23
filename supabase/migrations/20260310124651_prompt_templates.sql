-- ABOUTME: Prompt templates table for interview state versioning
-- ABOUTME: Creates amplify.prompt_templates with state/version tracking for idempotent prompt management

-- Prompt templates table
create table if not exists amplify.prompt_templates (
    id uuid primary key default extensions.uuid_generate_v4(),
    state text not null,
    version integer not null default 1,
    template_content text not null,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz
);
-- Create index for fast lookups by state and version
create index if not exists idx_prompt_templates_state_version on amplify.prompt_templates(state, version);
-- Create index for filtering active templates
create index if not exists idx_prompt_templates_active on amplify.prompt_templates(is_active) where is_active = true;
-- Enable Row Level Security
alter table amplify.prompt_templates enable row level security;
-- Create RLS policies for prompt_templates
create policy "Prompt templates are viewable by authenticated users"
    on amplify.prompt_templates for select
    to authenticated
    using (true);
create policy "Prompt templates are insertable by service role"
    on amplify.prompt_templates for insert
    to service_role
    with check (true);
create policy "Prompt templates are updatable by service role"
    on amplify.prompt_templates for update
    to service_role
    using (true);
-- Add updated_at trigger
create trigger handle_prompt_templates_updated_at
    before update on amplify.prompt_templates
    for each row
    execute function amplify.handle_updated_at();
-- Grant permissions to roles
grant select on amplify.prompt_templates to authenticated;
grant all on amplify.prompt_templates to service_role;
-- Idempotency: Ensure only one active version per state
-- This ensures that when a new version is activated, the old version is deactivated
create or replace function amplify.ensure_single_active_template()
returns trigger as $$
declare
    active_template_id uuid;
begin
    if new.is_active = true then
        -- Find any existing active template for the same state
        select id into active_template_id
        from amplify.prompt_templates
        where state = new.state
          and is_active = true
          and id != new.id
        limit 1;

        -- If another active template exists, deactivate it
        if active_template_id is not null then
            update amplify.prompt_templates
            set is_active = false
            where id = active_template_id;
        end if;
    end if;

    return new;
end;
$$ language plpgsql;
-- Create trigger for ensuring single active template per state
create trigger ensure_single_active_template_per_state
    before insert or update on amplify.prompt_templates
    for each row
    when (new.is_active = true)
    execute function amplify.ensure_single_active_template();
