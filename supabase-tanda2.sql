-- =====================================================================
-- SAMMELO · TANDA 2 · Invitaciones, administración, usuarios en vivo,
--                      estadísticas y espacios publicitarios
-- =====================================================================
-- CÓMO USARLO (Supabase → SQL Editor → New query). Pega y ejecuta
-- CADA PASO POR SEPARADO, en orden, y comprueba el resultado:
--
--   PASO 0  Solo lectura. Muestra tus políticas actuales. No cambia nada.
--   PASO 1  SEGURO. Crea tablas y funciones NUEVAS. Lo único que toca de lo
--           existente: añade la columna "approved" a "profiles" y un
--           disparador que impide que un usuario normal se cambie su propio
--           rol, aprobación o bloqueo. Tu app sigue funcionando igual.
--   PASO 2  MODIFICA DATOS (aprueba a tus usuarios actuales y te marca como
--           administrador). Está comentado: léelo y descomenta lo que quieras.
--   PASO 3  ACTIVA EL CIERRE POR INVITACIÓN en canciones y almacenamiento.
--           Está comentado. Hay un bloque de reversa al final.
--
-- Todo es repetible: ejecutar un paso dos veces no rompe nada.
-- Este archivo NUNCA borra datos tuyos.
-- =====================================================================


-- =====================================================================
-- PASO 0 · SOLO LECTURA (recomendado: ejecútalo y guarda el resultado)
-- =====================================================================
-- select schemaname, tablename, policyname, cmd, roles, qual
--   from pg_policies
--  where schemaname in ('public','storage')
--  order by schemaname, tablename, policyname;
--
-- select column_name, data_type from information_schema.columns
--  where table_schema='public' and table_name='profiles' order by ordinal_position;


-- =====================================================================
-- PASO 1 · ESTRUCTURA NUEVA (segura)
-- =====================================================================

-- 1.1 Columna de aprobación en profiles (solo se añade; nada se borra)
alter table public.profiles add column if not exists approved boolean not null default false;

-- 1.2 Funciones de permiso. SECURITY DEFINER para consultar profiles sin
--     depender de sus políticas; solo responden sí/no sobre quien llama.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p
                  where p.id = auth.uid() and p.role = 'admin'
                    and coalesce(p.blocked,false) = false)
$$;

create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and coalesce(p.blocked,false) = false
       and (p.role = 'admin' or p.approved))
$$;

-- 1.3 Tablas nuevas
create table if not exists public.invites (
  email      text primary key check (email = lower(email)),
  note       text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  used_at    timestamptz
);

create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Presencia: UNA fila por usuario. Nunca se guarda IP, contraseña ni correo.
create table if not exists public.presence (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  country      text not null default 'XX',      -- código ISO de 2 letras, aproximado
  device       text not null default 'other',   -- android | iphone | tablet | desktop | other
  state        text not null default 'browsing' check (state in ('browsing','listening','offline')),
  last_seen    timestamptz not null default now(),  -- último latido (la app está abierta)
  last_active  timestamptz not null default now()   -- última interacción real del usuario
);

-- Un registro por usuario y día (para "entraron hoy / esta semana / este mes")
create table if not exists public.visit_days (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  country text,
  device  text,
  primary key (user_id, day)
);

-- Reproducciones: canción + país + usuario (el panel solo muestra agregados)
create table if not exists public.plays (
  id         bigint generated always as identity primary key,
  user_id    uuid references auth.users(id) on delete set null,
  song_id    text not null,
  country    text,
  created_at timestamptz not null default now()
);
create index if not exists plays_song_idx on public.plays (song_id);
create index if not exists plays_time_idx on public.plays (created_at);

-- 1.4 RLS activada en todo lo nuevo. Sin política = nadie accede directamente.
alter table public.invites      enable row level security;
alter table public.app_settings enable row level security;
alter table public.presence     enable row level security;
alter table public.visit_days   enable row level security;
alter table public.plays        enable row level security;

revoke all on public.invites, public.app_settings, public.presence,
              public.visit_days, public.plays from anon;

grant select on public.presence, public.visit_days, public.plays to authenticated;
grant select, insert, update, delete on public.invites, public.app_settings to authenticated;

drop policy if exists invites_admin on public.invites;
create policy invites_admin on public.invites
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists settings_read on public.app_settings;
create policy settings_read on public.app_settings
  for select to authenticated using (public.is_approved());
drop policy if exists settings_write on public.app_settings;
create policy settings_write on public.app_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Solo el administrador LEE presencia, visitas y reproducciones.
-- Nadie escribe directamente: se escribe solo con las funciones de abajo.
drop policy if exists presence_admin_read on public.presence;
create policy presence_admin_read on public.presence
  for select to authenticated using (public.is_admin());
drop policy if exists visits_admin_read on public.visit_days;
create policy visits_admin_read on public.visit_days
  for select to authenticated using (public.is_admin());
drop policy if exists plays_admin_read on public.plays;
create policy plays_admin_read on public.plays
  for select to authenticated using (public.is_admin());

-- 1.5 Protección de profiles: un usuario normal NO puede cambiarse el rol,
--     la aprobación ni el bloqueo, aunque tu política actual le deje
--     actualizar su fila. Es SECURITY INVOKER a propósito: así distingue
--     "un usuario desde la app" (rol authenticated) de "el SQL Editor o una
--     función del sistema" (otro rol), que sí pueden cambiarlos.
create or replace function public.profiles_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user not in ('authenticated','anon') then return new; end if;
  if public.is_admin() then return new; end if;
  if tg_op = 'INSERT' then
    new.role := case when new.role = 'admin' then 'user' else new.role end;
    new.approved := false;
    new.blocked  := false;
  else
    if new.role is distinct from old.role
       or new.approved is distinct from old.approved
       or new.blocked  is distinct from old.blocked then
      raise exception 'No permitido' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard_t on public.profiles;
create trigger profiles_guard_t before insert or update on public.profiles
  for each row execute function public.profiles_guard();

-- 1.6 Invitación: la app llama a esto al entrar. Si tu correo está invitado
--     Y está confirmado (así nadie se registra con un correo ajeno), te
--     aprueba y marca la invitación como usada. Devuelve true/false.
create or replace function public.claim_invite() returns boolean
language plpgsql security definer set search_path = public, auth as $$
declare
  uid  uuid := auth.uid();
  mail text;
  ok   boolean;
begin
  if uid is null then return false; end if;
  select lower(u.email), (u.email_confirmed_at is not null) into mail, ok
    from auth.users u where u.id = uid;
  if coalesce(ok,false) and mail is not null and exists (select 1 from public.invites where email = mail) then
    update public.profiles set approved = true where id = uid and not coalesce(blocked,false);
    if not found then
      insert into public.profiles (id, approved) values (uid, true) on conflict (id) do nothing;
    end if;
    update public.invites set used_at = coalesce(used_at, now()) where email = mail;
  end if;
  return public.is_approved();
end $$;

-- 1.7 Latido de presencia (la app lo envía cada ~25 s mientras está abierta).
--     Recibe SOLO: estado, si hubo actividad, código de país (2 letras) y tipo
--     de dispositivo. La IP nunca llega a la base de datos.
create or replace function public.heartbeat(p_state text, p_active boolean, p_country text, p_device text)
returns void language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  st  text := case when p_state = 'listening' then 'listening' else 'browsing' end;
  cc  text := case when upper(coalesce(p_country,'')) ~ '^[A-Z]{2}$' then upper(p_country) else 'XX' end;
  dv  text := case when p_device in ('android','iphone','tablet','desktop') then p_device else 'other' end;
  nm  text;
begin
  if uid is null or not public.is_approved() then return; end if;
  select coalesce(nullif(trim(display_name),''), split_part(coalesce(auth.jwt()->>'email','usuario'),'@',1))
    into nm from public.profiles where id = uid;
  nm := left(coalesce(nm, 'usuario'), 60);
  insert into public.presence as p (user_id, display_name, country, device, state, last_seen, last_active)
  values (uid, nm, cc, dv, st, now(), now())
  on conflict (user_id) do update set
    display_name = excluded.display_name, country = excluded.country, device = excluded.device,
    state = excluded.state, last_seen = now(),
    last_active = case when p_active then now() else p.last_active end;
  insert into public.visit_days (user_id, day, country, device)
  values (uid, (now() at time zone 'utc')::date, cc, dv) on conflict do nothing;
end $$;

-- 1.8 Desconexión inmediata (la app lo llama al cerrar/ocultar)
create or replace function public.go_offline() returns void
language sql security definer set search_path = public as $$
  update public.presence set state = 'offline', last_seen = now() - interval '1 hour'
   where user_id = auth.uid()
$$;

-- 1.9 Registrar reproducción (la app lo llama tras ~20 s de escucha).
--     Anti-abuso: ignora la misma canción en 20 s y cualquier canción si ya
--     hubo otra reproducción del mismo usuario hace menos de 8 s.
create or replace function public.log_play(p_song text, p_country text default null)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null or not public.is_approved() or coalesce(p_song,'') = '' or length(p_song) > 80 then return; end if;
  if exists (select 1 from public.plays where user_id = uid and created_at > now() - interval '8 seconds') then return; end if;
  if exists (select 1 from public.plays where user_id = uid and song_id = p_song
                and created_at > now() - interval '20 seconds') then return; end if;
  insert into public.plays (user_id, song_id, country)
  values (uid, p_song, case when upper(coalesce(p_country,'')) ~ '^[A-Z]{2}$' then upper(p_country) else 'XX' end);
end $$;

-- 1.10 Funciones SOLO ADMIN. Cada una comprueba is_admin() y falla si no lo eres.
--      conectado  = latido en los últimos 70 s
--      activo     = conectado y con interacción en los últimos 120 s
--      escuchando = conectado y reproduciendo audio
create or replace function public.admin_live() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not public.is_admin() then raise exception 'No autorizado' using errcode = '42501'; end if;
  with c as (
    select * from public.presence
     where state <> 'offline' and last_seen > now() - interval '70 seconds')
  select jsonb_build_object(
    'now', now(),
    'connected', (select count(*) from c),
    'active',    (select count(*) from c where last_active > now() - interval '120 seconds'),
    'listening', (select count(*) from c where state = 'listening'),
    'browsing',  (select count(*) from c where state = 'browsing'),
    'by_country',(select coalesce(jsonb_agg(jsonb_build_object('country',country,'n',n) order by n desc),'[]')
                    from (select country, count(*) n from c group by country) x),
    'by_device', (select coalesce(jsonb_agg(jsonb_build_object('device',device,'n',n) order by n desc),'[]')
                    from (select device, count(*) n from c group by device) x),
    'users',     (select coalesce(jsonb_agg(jsonb_build_object(
                      'name',display_name,'country',country,'device',device,'state',state,
                      'last_active',last_active,'last_seen',last_seen,
                      'active', last_active > now() - interval '120 seconds')
                      order by last_active desc),'[]')
                    from (select * from c order by last_active desc limit 500) y)
  ) into r;
  return r;
end $$;

create or replace function public.admin_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb; d0 date := (now() at time zone 'utc')::date;
begin
  if not public.is_admin() then raise exception 'No autorizado' using errcode = '42501'; end if;
  select jsonb_build_object(
    'today',  (select count(*) from public.visit_days where day = d0),
    'week',   (select count(*) from public.visit_days where day >= d0 - 6),    -- últimos 7 días
    'month',  (select count(*) from public.visit_days where day >= d0 - 29),   -- últimos 30 días
    'users_total', (select count(*) from public.profiles),
    'pending',     (select count(*) from public.profiles where not approved and coalesce(role,'') <> 'admin' and not coalesce(blocked,false)),
    'plays_total', (select count(*) from public.plays),
    'plays_today', (select count(*) from public.plays where created_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')),
    'top_songs', (select coalesce(jsonb_agg(jsonb_build_object('song_id',song_id,'title',title,'artist',artist,'plays',n) order by n desc),'[]')
                    from (select p.song_id, s.title, s.artist, count(*) n
                            from public.plays p left join public.songs s on s.id::text = p.song_id
                           group by p.song_id, s.title, s.artist order by n desc limit 200) t),
    'visitors_by_country', (select coalesce(jsonb_agg(jsonb_build_object('country',country,'n',n) order by n desc),'[]')
                    from (select coalesce(country,'XX') country, count(distinct user_id) n from public.visit_days
                           where day >= d0 - 29 group by 1) v),
    'plays_by_country', (select coalesce(jsonb_agg(jsonb_build_object('country',country,'n',n) order by n desc),'[]')
                    from (select coalesce(country,'XX') country, count(*) n from public.plays group by 1) q)
  ) into r;
  return r;
end $$;

create or replace function public.admin_users() returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'No autorizado' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id',p.id,'email',u.email,'name',p.display_name,'role',p.role,
      'approved',p.approved,'blocked',coalesce(p.blocked,false),
      'created_at',u.created_at,'last_sign_in',u.last_sign_in_at)
      order by u.created_at desc)
    from (select * from public.profiles limit 2000) p join auth.users u on u.id = p.id), '[]');
end $$;

create or replace function public.admin_set_user(p_id uuid, p_approved boolean, p_blocked boolean, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'No autorizado' using errcode = '42501'; end if;
  if p_role not in ('admin','user') then raise exception 'Rol inválido'; end if;
  if p_id = auth.uid() and (p_blocked or p_role <> 'admin') then
    raise exception 'No puedes quitarte tu propio acceso de administrador';
  end if;
  update public.profiles set approved = p_approved, blocked = p_blocked, role = p_role where id = p_id;
end $$;

-- Invitar por correo (varios a la vez). Si ya tienen cuenta, quedan aprobados al instante.
create or replace function public.admin_invite(p_emails text[]) returns integer
language plpgsql security definer set search_path = public, auth as $$
declare e text; n int := 0;
begin
  if not public.is_admin() then raise exception 'No autorizado' using errcode = '42501'; end if;
  foreach e in array p_emails loop
    e := lower(trim(e));
    if e ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      insert into public.invites (email, created_by) values (e, auth.uid()) on conflict do nothing;
      update public.profiles set approved = true
       where id in (select id from auth.users where lower(email) = e) and not coalesce(blocked,false);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- 1.11 Permisos de ejecución: nunca para anónimos, salvo las dos funciones de
--      permiso (devuelven false si no hay sesión) que necesitan las políticas.
revoke all on function public.is_admin(), public.is_approved(), public.claim_invite(),
  public.heartbeat(text,boolean,text,text), public.go_offline(), public.log_play(text,text),
  public.admin_live(), public.admin_stats(), public.admin_users(),
  public.admin_set_user(uuid,boolean,boolean,text), public.admin_invite(text[]) from public, anon;
grant execute on function public.is_admin(), public.is_approved() to anon, authenticated;
grant execute on function public.claim_invite(),
  public.heartbeat(text,boolean,text,text), public.go_offline(), public.log_play(text,text),
  public.admin_live(), public.admin_stats(), public.admin_users(),
  public.admin_set_user(uuid,boolean,boolean,text), public.admin_invite(text[]) to authenticated;

-- 1.12 Ajustes iniciales de publicidad: TODO APAGADO por defecto
--      (top = banner superior, library = bloque en la biblioteca,
--       webview = permitir anuncios web dentro de la app Android,
--       client = tu ID de editor "ca-pub-…", slot_* = IDs de bloque de anuncios)
insert into public.app_settings (key, value) values
  ('ads', '{"top":false,"library":false,"webview":false,"client":"","slot_top":"","slot_library":""}'::jsonb)
on conflict (key) do nothing;

-- 1.13 Tiempo real para el panel (RLS garantiza que solo el administrador
--      recibe los cambios de presencia)
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime'
                  and schemaname='public' and tablename='presence') then
    alter publication supabase_realtime add table public.presence;
  end if;
end $$;


-- =====================================================================
-- PASO 2 · MODIFICA DATOS (léelo antes; descomenta SOLO lo que quieras)
-- =====================================================================
-- 2.1 Ver cuántos usuarios tienes y cuáles son administradores (solo lectura):
-- select role, approved, count(*) from public.profiles group by role, approved;
--
-- 2.2 Aprobar a TODOS los usuarios que ya existen, para que no queden fuera
--     cuando actives el PASO 3. Cambia SOLO la columna "approved":
-- update public.profiles set approved = true where not coalesce(blocked,false);
--
-- 2.3 Marcarte como administrador (cambia el correo; modifica 1 fila):
-- update public.profiles set role = 'admin', approved = true
--  where id = (select id from auth.users where lower(email) = lower('TU_CORREO@ejemplo.com'));
--
-- 2.4 Comprueba que tu cuenta quedó bien (debe salir role=admin, approved=true):
-- select u.email, p.role, p.approved, p.blocked
--   from public.profiles p join auth.users u on u.id = p.id
--  where p.role = 'admin';


-- =====================================================================
-- PASO 3 · ACTIVAR EL CIERRE POR INVITACIÓN
-- =====================================================================
-- Políticas RESTRICTIVAS: se SUMAN a las que ya tienes (no las reemplazan).
-- A partir de aquí, quien no esté aprobado no puede leer canciones ni crear
-- enlaces de audio. REQUIERE haber hecho 2.2 y 2.3, o te quedarás sin acceso.
--
-- drop policy if exists gate_songs on public.songs;
-- create policy gate_songs on public.songs as restrictive for select using (public.is_approved());
--
-- drop policy if exists gate_storage_songs on storage.objects;
-- create policy gate_storage_songs on storage.objects as restrictive for select
--   using (bucket_id <> 'songs' or public.is_approved());
--
-- REVERSA del PASO 3 (vuelve a como estaba antes):
-- drop policy if exists gate_songs on public.songs;
-- drop policy if exists gate_storage_songs on storage.objects;
