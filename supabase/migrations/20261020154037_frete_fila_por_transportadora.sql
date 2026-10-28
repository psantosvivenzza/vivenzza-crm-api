-- Sem disparos, alteração de flags ou encerramento de cotações existentes.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
alter table public.frete_consultas
 add column if not exists aguarda_contato boolean not null default false,
 add column if not exists contato_liberado boolean not null default false,
 add column if not exists exige_referencia boolean not null default false;

create or replace function public.frete_contato_chave(p_telefone text) returns text
language sql immutable strict set search_path='' as $$
 select case when length(p_telefone)=13 then left(p_telefone,4)||substring(p_telefone from 6) else p_telefone end
$$;
drop index if exists public.frete_consulta_telefone_aberto;
create unique index frete_consulta_telefone_aberto on public.frete_consultas
 (instance_name,public.frete_contato_chave(telefone))
 where status not in ('rascunho','encerrada') and not aguarda_contato and not contato_liberado;

create table if not exists public.frete_respostas_pendentes (
 id uuid primary key default gen_random_uuid(),instance_name text not null,
 telefone text not null,evolution_id text not null unique,texto text not null check(length(texto)<=10000),
 consulta_id uuid references public.frete_consultas(id),created_at timestamptz not null default now()
);
alter table public.frete_respostas_pendentes
 add column if not exists anexo_status text check(anexo_status in('processando','preservado','revisao')),
 add column if not exists mimetype text,
 add column if not exists conteudo_base64 text check(length(conteudo_base64)<=11184812),
 add column if not exists sha256 text;
alter table public.frete_respostas_pendentes enable row level security;
revoke all on public.frete_respostas_pendentes from public,anon,authenticated;
grant all on public.frete_respostas_pendentes to service_role;
create index if not exists frete_respostas_pendentes_contato on public.frete_respostas_pendentes(instance_name,telefone) where consulta_id is null;

create or replace function public.frete_enfileirar_cotacao(p_cotacao_id uuid,p_texto text,p_actor text) returns integer
language plpgsql security invoker set search_path='' as $$
declare c public.frete_cotacoes;q public.frete_consultas;f public.fornecedores;n integer:=0;ocupado boolean;
begin
 perform pg_advisory_xact_lock(78141014);
 select * into c from public.frete_cotacoes where id=p_cotacao_id for update;
 if not found or c.status<>'aberta' then raise exception 'Cotação encerrada ou não encontrada.';end if;
 for q in select * from public.frete_consultas where cotacao_id=c.id and status='rascunho' order by id for update loop
  select * into f from public.fornecedores where id=q.fornecedor_id for share;
  if not f.ativo or not f.participa_cotacao_frete or not f.cotacao_frete_consentimento or f.telefone_cotacao_frete is distinct from q.telefone then
   raise exception 'Revise a habilitação, consentimento e WhatsApp das transportadoras.';
  end if;
  select exists(select 1 from public.frete_consultas a where a.id<>q.id and a.instance_name=q.instance_name
   and public.frete_contato_chave(a.telefone)=public.frete_contato_chave(q.telefone)
   and a.status not in('rascunho','encerrada') and not a.contato_liberado) into ocupado;
  insert into public.frete_envios(consulta_id,telefone,texto,idempotency_key)
   values(q.id,q.telefone,p_texto,'solicitacao:'||q.id::text) on conflict(idempotency_key) do nothing;
  update public.frete_consultas set status='fila',aguarda_contato=ocupado,atualizado_por=p_actor,
   exige_referencia=exists(select 1 from public.frete_consultas h join public.frete_envios s on s.consulta_id=h.id
    where h.id<>q.id and h.instance_name=q.instance_name and public.frete_contato_chave(h.telefone)=public.frete_contato_chave(q.telefone) and s.attempted_at is not null)
   where id=q.id;
  n:=n+1;
 end loop;
 return n;
end $$;

-- Pula contatos ocupados: uma transportadora não bloqueia as demais.
create or replace function public.frete_proximo_envio() returns setof public.frete_envios
language plpgsql security invoker set search_path='' as $$
declare e public.frete_envios;q public.frete_consultas;cid uuid;referencia boolean;
begin
 if not pg_try_advisory_xact_lock(78141014) then return;end if;
 for e in select s.* from public.frete_envios s join public.frete_consultas a on a.id=s.consulta_id
  join public.frete_cotacoes c on c.id=a.cotacao_id
  where s.status='fila' and c.status='aberta' and not a.ia_pausada and not a.contato_liberado
   and a.status not in('rascunho','encerrada') order by s.created_at,s.id loop
  select cotacao_id into cid from public.frete_consultas where id=e.consulta_id;
  perform 1 from public.frete_cotacoes where id=cid and status='aberta' for update;
  if not found then continue;end if;
  select * into q from public.frete_consultas where id=e.consulta_id for update;
  if q.ia_pausada or q.contato_liberado or q.status in('rascunho','encerrada') then continue;end if;
  if exists(select 1 from public.frete_consultas a where a.id<>q.id and a.instance_name=q.instance_name
   and public.frete_contato_chave(a.telefone)=public.frete_contato_chave(q.telefone)
   and a.status not in('rascunho','encerrada') and not a.contato_liberado and not a.aguarda_contato) then continue;end if;
  -- Encerrar a cotação não prova que uma requisição em voo terminou.
  if exists(select 1 from public.frete_consultas h join public.frete_envios s on s.consulta_id=h.id
   where h.id<>q.id and not h.contato_liberado and h.instance_name=q.instance_name
    and public.frete_contato_chave(h.telefone)=public.frete_contato_chave(q.telefone)
    and (s.status='enviando' or(s.status='revisao' and s.attempted_at is not null and s.provider_id is null))) then continue;end if;
  select q.exige_referencia or exists(
   select 1 from public.frete_consultas h join public.frete_envios s on s.consulta_id=h.id
   where h.id<>q.id and h.instance_name=q.instance_name and public.frete_contato_chave(h.telefone)=public.frete_contato_chave(q.telefone)
    and s.attempted_at is not null) into referencia;
  update public.frete_consultas set aguarda_contato=false,exige_referencia=referencia
   where id=q.id and (aguarda_contato or exige_referencia is distinct from referencia);
  return next e;return;
 end loop;
end $$;

create or replace function public.frete_claim_envio(p_envio_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare e public.frete_envios;q public.frete_consultas;c public.frete_cotacoes;
begin
 if not pg_try_advisory_xact_lock(78141014) then return null;end if;
 if exists(select 1 from public.frete_envios where attempted_at>now()-interval '60 seconds') then return null;end if;
 select * into e from public.frete_envios where id=p_envio_id and status='fila';
 if not found then return null;end if;
 select * into q from public.frete_consultas where id=e.consulta_id;
 select * into c from public.frete_cotacoes where id=q.cotacao_id for update;
 select * into e from public.frete_envios where id=p_envio_id and status='fila' for update;
 if not found then return null;end if;
 select * into q from public.frete_consultas where id=e.consulta_id for update;
 if q.aguarda_contato then return null;end if;
 if c.status<>'aberta' or q.status in('rascunho','encerrada') or q.ia_pausada or q.contato_liberado then
  update public.frete_envios set status='bloqueado',error_code='cotacao_pausada_encerrada' where id=e.id;
  return null;
 end if;
 update public.frete_envios set status='enviando',attempted_at=now() where id=e.id returning * into e;
 return to_jsonb(e);
end $$;

-- Libera só esta conversa; cotação, proposta, auditoria e reservas sobrevivem.
create or replace function public.frete_liberar_contato(p_cotacao_id uuid,p_consulta_id uuid,p_versao timestamptz,p_actor text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare q public.frete_consultas;
begin
 perform pg_advisory_xact_lock(78141014);
 perform 1 from public.frete_cotacoes where id=p_cotacao_id and status='aberta' for update;
 if not found then raise exception 'Cotação encerrada ou não encontrada.';end if;
 select * into q from public.frete_consultas where id=p_consulta_id and cotacao_id=p_cotacao_id for update;
 if not found or q.updated_at is distinct from p_versao then raise exception 'Atendimento alterado. Atualize antes de liberar.';end if;
 if q.aguarda_contato or q.status='rascunho' or q.contato_liberado then raise exception 'Esta consulta não possui atendimento ativo.';end if;
 if exists(select 1 from public.frete_envios where consulta_id=q.id and (status='enviando' or(status='revisao' and attempted_at is not null and provider_id is null))) then raise exception 'Envio em andamento ou incerto. Confira antes de liberar.';end if;
 update public.frete_envios set status='bloqueado',error_code='contato_liberado' where consulta_id=q.id and status='fila';
 update public.frete_consultas set contato_liberado=true,ia_pausada=true,atualizado_por=p_actor where id=q.id returning * into q;
 return to_jsonb(q);
end $$;

create or replace function public.frete_associar_resposta(p_cotacao_id uuid,p_consulta_id uuid,p_resposta_id uuid,p_versao timestamptz,p_actor text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare q public.frete_consultas;r public.frete_respostas_pendentes;mid uuid;
begin
 perform pg_advisory_xact_lock(78141014);
 perform 1 from public.frete_cotacoes where id=p_cotacao_id and status='aberta' for update;
 if not found then raise exception 'Cotação encerrada ou não encontrada.';end if;
 select * into q from public.frete_consultas where id=p_consulta_id and cotacao_id=p_cotacao_id for update;
 if not found or q.updated_at is distinct from p_versao then raise exception 'Atendimento alterado. Atualize antes de associar.';end if;
 if q.status in('rascunho','encerrada') then raise exception 'Solicitação não iniciada ou encerrada.';end if;
 select * into r from public.frete_respostas_pendentes where id=p_resposta_id for update;
 if not found or r.consulta_id is not null or r.instance_name<>q.instance_name or public.frete_contato_chave(r.telefone)<>public.frete_contato_chave(q.telefone) then raise exception 'Resposta não pertence a este contato ou já foi associada.';end if;
 if r.anexo_status='processando' then
  if r.created_at>clock_timestamp()-interval '2 minutes' then raise exception 'Anexo em processamento; atualize antes de associar.';end if;
  update public.frete_respostas_pendentes set anexo_status='revisao' where id=r.id;
  r.anexo_status:='revisao';
 end if;
 insert into public.frete_mensagens(cotacao_id,consulta_id,direcao,texto,evolution_id) values(q.cotacao_id,q.id,'entrada',r.texto,r.evolution_id) returning id into mid;
 if r.anexo_status is not null then
  insert into public.frete_anexos(mensagem_id,cotacao_id,status,mimetype,conteudo_base64,sha256)
   values(mid,q.cotacao_id,case when r.conteudo_base64 is null then 'revisao' else 'preservado' end,r.mimetype,r.conteudo_base64,r.sha256);
 end if;
 update public.frete_respostas_pendentes set consulta_id=q.id where id=r.id;
 update public.frete_consultas set ia_pausada=true,atualizado_por=p_actor where id=q.id returning * into q;
 update public.frete_envios set status='bloqueado',error_code='associacao_humana' where consulta_id=q.id and status='fila';
 return to_jsonb(q);
end $$;
revoke all on function public.frete_contato_chave(text),public.frete_proximo_envio(),public.frete_liberar_contato(uuid,uuid,timestamptz,text),public.frete_associar_resposta(uuid,uuid,uuid,timestamptz,text) from public,anon,authenticated;
grant execute on function public.frete_contato_chave(text),public.frete_proximo_envio(),public.frete_liberar_contato(uuid,uuid,timestamptz,text),public.frete_associar_resposta(uuid,uuid,uuid,timestamptz,text) to service_role;
commit;
