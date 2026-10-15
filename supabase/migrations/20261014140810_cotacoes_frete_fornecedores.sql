-- Aditiva; nenhum envio é habilitado pela migration. Backend usa service_role.
begin;
alter table public.fornecedores
  add column participa_cotacao_frete boolean not null default false,
  add column telefone_cotacao_frete text,
  add column cotacao_frete_consentimento boolean not null default false,
  add column cotacao_frete_atualizada_em timestamptz,
  add column cotacao_frete_atualizada_por text,
  add constraint fornecedor_telefone_frete check (telefone_cotacao_frete is null or telefone_cotacao_frete ~ '^55[0-9]{2}([0-9]{8}|9[0-9]{8})$'),
  add constraint fornecedor_cotacao_telefone check (not participa_cotacao_frete or telefone_cotacao_frete is not null);

create table public.frete_cotacoes (
 id uuid primary key default gen_random_uuid(), dados jsonb not null,
 status text not null default 'aberta' check (status in ('aberta','encerrada')),
 criado_por text not null, atualizado_por text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.frete_consultas (
 id uuid primary key default gen_random_uuid(), cotacao_id uuid not null references public.frete_cotacoes(id),
 fornecedor_id uuid not null references public.fornecedores(id), nome_transportadora text not null,
 telefone text not null check (telefone ~ '^55[0-9]{2}([0-9]{8}|9[0-9]{8})$'),
 instance_name text not null default 'vivenzza-financeiro' check (instance_name = 'vivenzza-financeiro'),
 status text not null default 'rascunho' check (status in ('rascunho','fila','enviando','aguardando','recebida','revisao','falha','encerrada')),
 ia_pausada boolean not null default false,
 valor_total numeric(14,2) check (valor_total > 0), prazo_dias integer check (prazo_dias between 0 and 365),
 validade timestamptz, completa boolean not null default false, protocolo text, observacoes text,
 atualizado_por text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique (cotacao_id, fornecedor_id), unique (id, cotacao_id),
 check (not completa or (valor_total is not null and prazo_dias is not null and validade is not null))
);
-- No MVP, não abre duas conversas de frete simultâneas para o mesmo contato.
create unique index frete_consulta_telefone_aberto on public.frete_consultas
 ((case when length(telefone)=13 then left(telefone,4) || substring(telefone from 6) else telefone end))
 where status <> 'encerrada';
create index frete_consultas_cotacao on public.frete_consultas(cotacao_id);
create table public.frete_mensagens (
 id uuid primary key default gen_random_uuid(), cotacao_id uuid not null, consulta_id uuid not null,
 direcao text not null check (direcao in ('entrada','saida')), texto text not null,
 evolution_id text unique, created_at timestamptz not null default now(),
 foreign key (consulta_id,cotacao_id) references public.frete_consultas(id,cotacao_id)
);
create index frete_mensagens_cotacao on public.frete_mensagens(cotacao_id,created_at);
create table public.frete_envios (
 id uuid primary key default gen_random_uuid(), consulta_id uuid not null references public.frete_consultas(id),
 mensagem_id uuid references public.frete_mensagens(id),
 instance_name text not null default 'vivenzza-financeiro' check (instance_name = 'vivenzza-financeiro'),
 telefone text not null, texto text not null, idempotency_key text not null unique,
 status text not null default 'fila' check (status in ('fila','enviando','enviado','revisao','bloqueado')),
 provider_id text, error_code text, attempted_at timestamptz, created_at timestamptz not null default now()
);
create index frete_envios_fila on public.frete_envios(created_at) where status = 'fila';
create index frete_envios_tentativas on public.frete_envios(attempted_at) where attempted_at is not null;

alter table public.frete_cotacoes enable row level security;
alter table public.frete_consultas enable row level security;
alter table public.frete_mensagens enable row level security;
alter table public.frete_envios enable row level security;
revoke all on public.frete_cotacoes,public.frete_consultas,public.frete_mensagens,public.frete_envios from anon,authenticated;
grant all on public.frete_cotacoes,public.frete_consultas,public.frete_mensagens,public.frete_envios to service_role;

create function public.frete_criar_cotacao(p_dados jsonb, p_ids uuid[], p_actor text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare c public.frete_cotacoes; f public.fornecedores; v_id uuid;
begin
 if cardinality(p_ids) not between 1 and 30 then raise exception 'Selecione transportadoras.'; end if;
 insert into public.frete_cotacoes(dados,criado_por) values(p_dados,p_actor) returning * into c;
 foreach v_id in array p_ids loop
   select * into f from public.fornecedores where id=v_id for share;
   if not found or not f.ativo or not f.participa_cotacao_frete or f.telefone_cotacao_frete is null then
     raise exception 'Transportadora não habilitada para cotação.';
   end if;
   insert into public.frete_consultas(cotacao_id,fornecedor_id,nome_transportadora,telefone)
     values(c.id,f.id,f.razao_social,f.telefone_cotacao_frete);
 end loop;
 return to_jsonb(c);
end $$;

create function public.frete_enfileirar_cotacao(p_cotacao_id uuid,p_texto text,p_actor text) returns integer
language plpgsql security invoker set search_path = '' as $$
declare c public.frete_cotacoes; q public.frete_consultas; f public.fornecedores; n integer := 0;
begin
 select * into c from public.frete_cotacoes where id=p_cotacao_id for update;
 if not found or c.status <> 'aberta' then raise exception 'Cotação encerrada ou não encontrada.'; end if;
 for q in select * from public.frete_consultas where cotacao_id=c.id and status='rascunho' order by id for update loop
   select * into f from public.fornecedores where id=q.fornecedor_id for share;
   if not f.ativo or not f.participa_cotacao_frete or not f.cotacao_frete_consentimento or f.telefone_cotacao_frete <> q.telefone then
     raise exception 'Revise a habilitação, consentimento e WhatsApp das transportadoras.';
   end if;
   insert into public.frete_envios(consulta_id,telefone,texto,idempotency_key)
     values(q.id,q.telefone,p_texto,'solicitacao:' || q.id::text) on conflict(idempotency_key) do nothing;
   update public.frete_consultas set status='fila',atualizado_por=p_actor,updated_at=now() where id=q.id;
   n := n+1;
 end loop;
 return n;
end $$;

create function public.frete_claim_envio(p_envio_id uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare e public.frete_envios; q public.frete_consultas; c public.frete_cotacoes;
begin
 -- Uma reivindicação de frete por vez, inclusive entre réplicas.
 if not pg_try_advisory_xact_lock(78141014) then return null; end if;
 if exists(select 1 from public.frete_envios where attempted_at > now()-interval '90 seconds') then return null; end if;
 select * into e from public.frete_envios where id=p_envio_id and status='fila';
 if not found then return null; end if;
 select * into q from public.frete_consultas where id=e.consulta_id;
 -- Ordem de locks consistente com salvar/pausar/encerrar: cotação antes de envio.
 select * into c from public.frete_cotacoes where id=q.cotacao_id for update;
 select * into e from public.frete_envios where id=p_envio_id and status='fila' for update;
 if not found then return null; end if;
 select * into q from public.frete_consultas where id=e.consulta_id;
 if c.status <> 'aberta' or q.status='encerrada' or (e.mensagem_id is not null and q.ia_pausada) then
   update public.frete_envios set status='bloqueado',error_code='cotacao_pausada_encerrada' where id=e.id;
   return null;
 end if;
 update public.frete_envios set status='enviando',attempted_at=now() where id=e.id returning * into e;
 return to_jsonb(e);
end $$;

create function public.frete_salvar_proposta(p_cotacao_id uuid,p_consulta_id uuid,p_campos jsonb,p_actor text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare c public.frete_cotacoes; q public.frete_consultas;
begin
 select * into c from public.frete_cotacoes where id=p_cotacao_id for update;
 if not found or c.status <> 'aberta' then raise exception 'Cotação encerrada ou não encontrada.'; end if;
 update public.frete_consultas set valor_total=(p_campos->>'valor_total')::numeric,
 prazo_dias=(p_campos->>'prazo_dias')::integer,validade=(p_campos->>'validade')::timestamptz,
 completa=(p_campos->>'completa')::boolean,protocolo=p_campos->>'protocolo',observacoes=p_campos->>'observacoes',
 ia_pausada=(p_campos->>'ia_pausada')::boolean,status=case when (p_campos->>'completa')::boolean then 'recebida' else 'revisao' end,
 atualizado_por=p_actor,updated_at=now() where id=p_consulta_id and cotacao_id=c.id returning * into q;
 if not found then raise exception 'Consulta não pertence à cotação.'; end if;
 if q.ia_pausada then update public.frete_envios set status='bloqueado',error_code='revisao_humana' where consulta_id=q.id and status='fila'; end if;
 return to_jsonb(q);
end $$;

create function public.frete_pausar_consulta(p_cotacao_id uuid,p_consulta_id uuid,p_actor text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare c public.frete_cotacoes; q public.frete_consultas;
begin
 select * into c from public.frete_cotacoes where id=p_cotacao_id for update;
 if not found or c.status <> 'aberta' then raise exception 'Cotação encerrada ou não encontrada.'; end if;
 update public.frete_consultas set ia_pausada=true,atualizado_por=p_actor,updated_at=now()
   where id=p_consulta_id and cotacao_id=c.id returning * into q;
 if not found then raise exception 'Consulta não pertence à cotação.'; end if;
 update public.frete_envios set status='bloqueado',error_code='atendimento_humano' where consulta_id=q.id and status='fila';
 return to_jsonb(q);
end $$;

create function public.frete_enfileirar_resposta(p_consulta_id uuid,p_mensagem_id uuid,p_texto text) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare q public.frete_consultas; c public.frete_cotacoes; m public.frete_mensagens; n integer;
begin
 select cotacao_id into q.cotacao_id from public.frete_consultas where id=p_consulta_id;
 select * into c from public.frete_cotacoes where id=q.cotacao_id for update;
 select * into q from public.frete_consultas where id=p_consulta_id for update;
 if not found or c.status <> 'aberta' or q.ia_pausada or q.completa or q.status='encerrada' then return false; end if;
 select * into m from public.frete_mensagens where id=p_mensagem_id and consulta_id=q.id and direcao='entrada';
 if not found then raise exception 'Mensagem não pertence à consulta.'; end if;
 if exists(select 1 from public.frete_envios where idempotency_key='frete-resposta:'||m.id::text) then return true; end if;
 select count(*) into n from public.frete_envios where consulta_id=q.id and mensagem_id is not null;
 if n >= 6 then
   update public.frete_consultas set ia_pausada=true,status='revisao',updated_at=now() where id=q.id;
   update public.frete_envios set status='bloqueado',error_code='limite_assistente' where consulta_id=q.id and status='fila' and mensagem_id is not null;
   return false;
 end if;
 insert into public.frete_envios(consulta_id,mensagem_id,telefone,texto,idempotency_key)
 values(q.id,m.id,q.telefone,p_texto,'frete-resposta:'||m.id::text);
 return true;
end $$;

create function public.frete_encerrar_cotacao(p_cotacao_id uuid,p_actor text) returns void
language plpgsql security invoker set search_path = '' as $$
begin
 perform 1 from public.frete_cotacoes where id=p_cotacao_id for update;
 update public.frete_cotacoes set status='encerrada',atualizado_por=p_actor,updated_at=now() where id=p_cotacao_id;
 update public.frete_consultas set status='encerrada',ia_pausada=true,atualizado_por=p_actor,updated_at=now() where cotacao_id=p_cotacao_id;
 update public.frete_envios set status='bloqueado',error_code='cotacao_encerrada'
   where consulta_id in(select id from public.frete_consultas where cotacao_id=p_cotacao_id) and status='fila';
end $$;

revoke all on function public.frete_criar_cotacao(jsonb,uuid[],text),public.frete_enfileirar_cotacao(uuid,text,text),public.frete_claim_envio(uuid),public.frete_salvar_proposta(uuid,uuid,jsonb,text),public.frete_encerrar_cotacao(uuid,text),public.frete_pausar_consulta(uuid,uuid,text),public.frete_enfileirar_resposta(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.frete_criar_cotacao(jsonb,uuid[],text),public.frete_enfileirar_cotacao(uuid,text,text),public.frete_claim_envio(uuid),public.frete_salvar_proposta(uuid,uuid,jsonb,text),public.frete_encerrar_cotacao(uuid,text),public.frete_pausar_consulta(uuid,uuid,text),public.frete_enfileirar_resposta(uuid,uuid,text) to service_role;
commit;
