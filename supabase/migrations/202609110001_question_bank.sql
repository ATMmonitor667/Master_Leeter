-- Private versioned question bank. Apply only to the intended development
-- Supabase project first. No candidate role can read solutions, tests or briefs.
begin;

create table public.interview_questions (
  version_id text primary key check (version_id ~ '^[a-z0-9-]+@[1-9][0-9]*$'),
  public_ref text not null unique check (public_ref ~ '^scn_[a-f0-9]{16}$'),
  status text not null check (status in ('DRAFT', 'IN_REVIEW', 'ACTIVE', 'RETIRED')),
  content_yaml text not null check (octet_length(content_yaml) between 1 and 1000000),
  content_hash text not null check (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);

create index interview_questions_active_ref on public.interview_questions(public_ref) where status = 'ACTIVE';
alter table public.interview_questions enable row level security;
-- RLS intentionally has no anon/authenticated policy. Revoke grants as well.
revoke all on public.interview_questions from public, anon, authenticated, service_role;
grant select, insert on public.interview_questions to service_role;
grant update (status) on public.interview_questions to service_role;

create function public.preserve_interview_question_version()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Question versions cannot be deleted; retire them instead';
  end if;
  if new.version_id is distinct from old.version_id
    or new.public_ref is distinct from old.public_ref
    or new.content_yaml is distinct from old.content_yaml
    or new.content_hash is distinct from old.content_hash
    or new.created_at is distinct from old.created_at then
    raise exception 'Question content is immutable; create a new version';
  end if;
  return new;
end;
$$;
revoke all on function public.preserve_interview_question_version() from public, anon, authenticated;
create trigger preserve_interview_question_version
before update or delete on public.interview_questions
for each row execute function public.preserve_interview_question_version();

comment on table public.interview_questions is
  'Server-only original/licensed interview scenarios; source content is validated and hashed by the importer and reader.';
commit;
