-- Realm AI — Supabase / Postgres starter schema
-- Run in the Supabase SQL editor (or `supabase db reset` with the CLI).
-- Safe to re-run: everything is IF NOT EXISTS / CREATE OR REPLACE.

create extension if not exists pgcrypto;      -- gen_random_uuid()

-- ------------------------------------------------------------------ helpers
create or replace function realm_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ------------------------------------------------------------------- tables
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  email        text,
  plan         text not null default 'free',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  title      text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role            text not null check (role in ('user','assistant','system')),
  content         text not null,
  created_at      timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid references auth.users(id) on delete cascade,
  provider             text not null default 'paddle',
  provider_ref         text,                      -- Paddle subscription id (sub_...)
  paddle_customer_id   text,
  email                text,
  plan                 text not null,
  status               text not null,              -- active | trialing | past_due | canceled | paused
  current_period_end   timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (provider, provider_ref)
);

create table if not exists public.payments (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references auth.users(id) on delete set null,
  provider         text not null default 'paddle',
  provider_txn_id  text,
  amount         numeric(12,2) not null default 0,
  currency         text not null default 'USD',
  status           text not null,
  paid_at          timestamptz,
  raw_event        jsonb,
  created_at       timestamptz not null default now()
);

-- Raw provider notifications, written by /api/paddle/webhook (service role only).
create table if not exists public.payment_events (
  event_id     text primary key,
  event_type   text,
  occurred_at  timestamptz,
  processed_at timestamptz,
  payload      jsonb not null,
  received_at  timestamptz not null default now()
);

create table if not exists public.usage (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  period_start   date not null default (date_trunc('month', now()))::date,
  messages_count integer not null default 0,
  agent_runs     integer not null default 0,
  updated_at     timestamptz not null default now()
);

-- ------------------------------------------------------------------ indexes
create index if not exists messages_conversation_idx on public.messages (conversation_id, created_at);
create index if not exists conversations_user_idx    on public.conversations (user_id, updated_at desc);
create index if not exists subscriptions_email_idx    on public.subscriptions (lower(email));
create index if not exists payments_txn_idx           on public.payments (provider_txn_id);
create index if not exists payment_events_unprocessed_idx on public.payment_events (received_at) where processed_at is null;

-- --------------------------------------------------------------- triggers
do $$
declare t text;
begin
  foreach t in array array['profiles','conversations','subscriptions','usage'] loop
    execute format('drop trigger if exists %1$s_touch_updated_at on public.%1$s', t);
    execute format('create trigger %1$s_touch_updated_at before update on public.%1$s
                    for each row execute function realm_touch_updated_at()', t);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Row level security — WITHOUT this, the anon key can read every row.
-- ─────────────────────────────────────────────────────────────────────────
alter table public.profiles        enable row level security;
alter table public.conversations   enable row level security;
alter table public.messages        enable row level security;
alter table public.subscriptions   enable row level security;
alter table public.payments        enable row level security;
alter table public.payment_events  enable row level security;
alter table public.usage           enable row level security;

drop policy if exists "profiles: own row"        on public.profiles;
create policy "profiles: own row" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "conversations: own rows"  on public.conversations;
create policy "conversations: own rows" on public.conversations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "messages: own conversations" on public.messages;
create policy "messages: own conversations" on public.messages
  for all using (exists (select 1 from public.conversations c
                         where c.id = messages.conversation_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.conversations c
                       where c.id = messages.conversation_id and c.user_id = auth.uid()));

drop policy if exists "subscriptions: read own"  on public.subscriptions;
create policy "subscriptions: read own" on public.subscriptions
  for select using (auth.uid() = user_id);   -- writes happen server-side only (service role)

drop policy if exists "payments: read own"       on public.payments;
create policy "payments: read own" on public.payments
  for select using (auth.uid() = user_id);

drop policy if exists "usage: own row"           on public.usage;
create policy "usage: own row" on public.usage
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- payment_events: no policy at all => only the service role (used by the webhook) can touch it.

-- Auto-create a profile on signup so the app always has a row to read.
create or replace function public.realm_handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)), new.email)
  on conflict (id) do nothing;
  insert into public.usage (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists realm_on_auth_user_created on auth.users;
create trigger realm_on_auth_user_created after insert on auth.users
  for each row execute function public.realm_handle_new_user();

-- Realtime (optional): lets the UI react to plan changes without polling.
-- alter publication supabase_realtime add table public.subscriptions;
