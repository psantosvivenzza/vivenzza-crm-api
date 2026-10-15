-- Apenas schema. Ativacao operacional separada, com remetentes drenados.
begin;
create function public.frete_auditar_config() returns trigger language plpgsql set search_path='' as $$
begin
 if (new.participa_cotacao_frete,new.telefone_cotacao_frete,new.cotacao_frete_consentimento) is distinct from (old.participa_cotacao_frete,old.telefone_cotacao_frete,old.cotacao_frete_consentimento) or new.cotacao_frete_atualizada_por='opt_out_inbound' then
  new.cotacao_frete_atualizada_em=clock_timestamp();
 end if;
 return new;
end $$;
create trigger frete_config_versao before update on public.fornecedores for each row execute function public.frete_auditar_config();

create function public.frete_configurar_transportadora(p_id uuid,p_versao timestamptz,p_campos jsonb,p_actor text) returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.fornecedores;
begin
 select * into r from public.fornecedores where id=p_id for update;
 if not found then raise exception 'Fornecedor nao encontrado.'; end if;
 if r.cotacao_frete_atualizada_em is distinct from p_versao then raise exception 'Cadastro alterado. Atualize antes de salvar; consentimento anterior nao pode ser restaurado.'; end if;
 update public.fornecedores set participa_cotacao_frete=(p_campos->>'participa_cotacao_frete')::boolean,telefone_cotacao_frete=p_campos->>'telefone_cotacao_frete',cotacao_frete_consentimento=(p_campos->>'cotacao_frete_consentimento')::boolean,cotacao_frete_atualizada_em=clock_timestamp(),cotacao_frete_atualizada_por=p_actor,atualizado_em=clock_timestamp() where id=p_id returning * into r;
 return to_jsonb(r);
end $$;

create or replace function public.frete_salvar_proposta(p_cotacao_id uuid,p_consulta_id uuid,p_campos jsonb,p_actor text) returns jsonb language plpgsql security invoker set search_path='' as $$
declare c public.frete_cotacoes; q public.frete_consultas;
begin
 select * into c from public.frete_cotacoes where id=p_cotacao_id for update;
 if not found or c.status<>'aberta' then raise exception 'Cotacao encerrada ou nao encontrada.'; end if;
 select * into q from public.frete_consultas where id=p_consulta_id and cotacao_id=c.id for update;
 if not found then raise exception 'Consulta nao pertence a cotacao.'; end if;
 if not (p_campos ? 'versao') or q.updated_at is distinct from (p_campos->>'versao')::timestamptz then raise exception 'Proposta alterada. Atualize antes de salvar.'; end if;
 update public.frete_consultas set valor_total=(p_campos->>'valor_total')::numeric,prazo_dias=(p_campos->>'prazo_dias')::integer,validade=(p_campos->>'validade')::timestamptz,completa=(p_campos->>'completa')::boolean,protocolo=p_campos->>'protocolo',observacoes=p_campos->>'observacoes',ia_pausada=(p_campos->>'ia_pausada')::boolean,status=case when (p_campos->>'completa')::boolean then 'recebida' else 'revisao' end,atualizado_por=p_actor,updated_at=clock_timestamp() where id=q.id returning * into q;
 if q.ia_pausada then update public.frete_envios set status='bloqueado',error_code='revisao_humana' where consulta_id=q.id and status='fila'; end if;
 return to_jsonb(q);
end $$;

create function public.frete_versionar_consulta() returns trigger language plpgsql set search_path='' as $$
begin new.updated_at=clock_timestamp();return new;end $$;
create trigger frete_consulta_versao before update on public.frete_consultas for each row execute function public.frete_versionar_consulta();
create table public.frete_orcamento_controle(id integer primary key check(id=1),ativo boolean not null default false,ativado_em timestamptz,contar_historico_legado boolean not null default false,instancia_legado text not null default 'vivenzza-financeiro');
insert into public.frete_orcamento_controle(id) values(1);
create table public.frete_reservas_legado(id uuid primary key default gen_random_uuid(),instance_name text not null,created_at timestamptz not null default clock_timestamp());
create index frete_reservas_legado_data on public.frete_reservas_legado(created_at);
alter table public.frete_orcamento_controle enable row level security;
alter table public.frete_reservas_legado enable row level security;
revoke all on public.frete_orcamento_controle,public.frete_reservas_legado from anon,authenticated;
grant all on public.frete_orcamento_controle,public.frete_reservas_legado to service_role;

create function public.frete_ativar_orcamento(p_instancia_legado text default 'vivenzza-financeiro') returns void language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(78141015);
 if exists(select 1 from public.frete_orcamento_controle where ativado_em is not null and instancia_legado<>p_instancia_legado) then raise exception 'Instancia do historico ja fixada; revisar migracao antes de alterar.';end if;
 update public.frete_orcamento_controle set ativo=true,instancia_legado=p_instancia_legado,ativado_em=coalesce(ativado_em,clock_timestamp()),contar_historico_legado=case when ativado_em is null then not coalesce((select multi_whatsapp from public.automacoes_config where id=1),false) else contar_historico_legado end where id=1;
end $$;

create function public.frete_contar_orcamento(p_desde timestamptz,p_instancia text default null) returns bigint language sql security invoker set search_path='' as $$
 select
 (case when exists(select 1 from public.frete_orcamento_controle where ativado_em is not null) or coalesce((select multi_whatsapp from public.automacoes_config where id=1),false) then (select count(*) from public.collection_dispatch_attempts a join public.collection_dispatches d on d.id=a.dispatch_id left join public.whatsapp_instances i on i.id=a.whatsapp_instance_id where d.purpose='collection' and a.criado_em>=p_desde and (p_instancia is null or i.instance_name=p_instancia)) else 0 end)
 +(select count(*) from public.frete_envios e where e.attempted_at>=p_desde and (p_instancia is null or e.instance_name=p_instancia))
 +(select count(*) from public.frete_reservas_legado r where r.created_at>=p_desde and (p_instancia is null or r.instance_name=p_instancia))
 +(select count(*) from public.cobrancas_whatsapp c cross join public.frete_orcamento_controle o where ((o.ativado_em is not null and o.contar_historico_legado and c.data_envio<o.ativado_em) or(o.ativado_em is null and not coalesce((select multi_whatsapp from public.automacoes_config where id=1),false))) and c.data_envio>=p_desde and (p_instancia is null or p_instancia=o.instancia_legado));
$$;

create function public.frete_guardar_orcamento() returns trigger language plpgsql security invoker set search_path='' as $$
declare instancia text; cfg public.automacoes_config; i public.whatsapp_instances; dia timestamptz; hora timestamptz; ativo boolean;
begin
 -- Mesma trava para a reserva de frete, tentativa v2 e reserva do legado.
 perform pg_advisory_xact_lock(78141015);
 select o.ativo into ativo from public.frete_orcamento_controle o where id=1;
 if not coalesce(ativo,false) then
  if tg_table_name='frete_envios' then raise exception 'Orcamento compartilhado ainda nao ativado.'; end if;
  return new;
 end if;
 if tg_table_name='collection_dispatch_attempts' then
  if not exists(select 1 from public.collection_dispatches d where d.id=new.dispatch_id and d.purpose='collection') then return new; end if;
  select instance_name into instancia from public.whatsapp_instances where id=new.whatsapp_instance_id;
 else instancia=new.instance_name;
 end if;
 select * into cfg from public.automacoes_config where id=1;
 dia=(date_trunc('day',clock_timestamp() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo');
 hora=date_trunc('hour',clock_timestamp());
 if public.frete_contar_orcamento(dia)>=(case when cfg.id is null then 30 else cfg.global_daily_limit end) or public.frete_contar_orcamento(hora)>=(case when cfg.id is null then 10 else cfg.global_hourly_limit end) then raise exception 'limite_global_reserva'; end if;
 select * into i from public.whatsapp_instances where instance_name=instancia;
 if not found or not i.enabled then raise exception 'Instancia indisponivel para reserva.'; end if;
 if public.frete_contar_orcamento(dia,instancia)>=i.daily_limit or public.frete_contar_orcamento(hora,instancia)>=i.hourly_limit then raise exception 'limite_instancia_reserva'; end if;
 return new;
end $$;
create trigger frete_orcamento_v2 before insert on public.collection_dispatch_attempts for each row execute function public.frete_guardar_orcamento();
create trigger frete_orcamento_insercao before insert on public.frete_envios for each row when(new.attempted_at is not null) execute function public.frete_guardar_orcamento();
create trigger frete_orcamento_fila before update of attempted_at on public.frete_envios for each row when(old.attempted_at is null and new.attempted_at is not null) execute function public.frete_guardar_orcamento();
create trigger frete_orcamento_legado before insert on public.frete_reservas_legado for each row execute function public.frete_guardar_orcamento();
create function public.frete_reservar_legado(p_instancia text) returns uuid language plpgsql security invoker set search_path='' as $$
declare r uuid;
begin
 perform pg_advisory_xact_lock(78141015);
 if exists(select 1 from public.frete_orcamento_controle where not ativo and ativado_em is null) then return null;end if;
 insert into public.frete_reservas_legado(instance_name)values(p_instancia)returning id into r;return r;end $$;
revoke all on function public.frete_configurar_transportadora(uuid,timestamptz,jsonb,text),public.frete_ativar_orcamento(text),public.frete_contar_orcamento(timestamptz,text),public.frete_guardar_orcamento(),public.frete_auditar_config(),public.frete_versionar_consulta(),public.frete_reservar_legado(text) from public,anon,authenticated;
grant execute on function public.frete_configurar_transportadora(uuid,timestamptz,jsonb,text),public.frete_ativar_orcamento(text),public.frete_contar_orcamento(timestamptz,text),public.frete_guardar_orcamento(),public.frete_auditar_config(),public.frete_versionar_consulta(),public.frete_reservar_legado(text) to service_role;
commit;
