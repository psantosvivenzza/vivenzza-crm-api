begin;
-- Conteúdo e chaves de anexo nunca são expostos pela API de listagem.
create table if not exists public.frete_anexos (
 mensagem_id uuid primary key references public.frete_mensagens(id) on delete cascade,
 status text not null check(status in ('processando','preservado','lido','revisao')),
 mimetype text, conteudo_base64 text check(length(conteudo_base64)<=11184812),
 sha256 text, texto_extraido text check(length(texto_extraido)<=30000),
 created_at timestamptz not null default now()
);
alter table public.frete_anexos enable row level security;
alter table public.frete_anexos add column if not exists cotacao_id uuid references public.frete_cotacoes(id);
create index if not exists frete_anexos_cotacao on public.frete_anexos(cotacao_id);
revoke all on public.frete_anexos from public,anon,authenticated;
grant all on public.frete_anexos to service_role;
alter table public.frete_consultas add column if not exists proposta_evidencias jsonb not null default '{}';
create or replace function public.frete_registrar_progresso(p_consulta_id uuid,p_mensagem_id uuid,p_versao timestamptz,p_campos jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare q public.frete_consultas;c public.frete_cotacoes;m public.frete_mensagens; evid jsonb; done boolean; campo text;
begin
 select cotacao_id into q.cotacao_id from public.frete_consultas where id=p_consulta_id;
 select * into c from public.frete_cotacoes where id=q.cotacao_id for update;
 select * into q from public.frete_consultas where id=p_consulta_id for update;
 select * into m from public.frete_mensagens where id=p_mensagem_id and consulta_id=q.id and direcao='entrada';
 if not found or c.status<>'aberta' or q.status='encerrada' or q.completa or q.ia_pausada or q.updated_at is distinct from p_versao then return null;end if;
 evid=q.proposta_evidencias;
 foreach campo in array array['valor_total','prazo_dias','validade'] loop
  if p_campos ? campo and to_jsonb(q)->>campo is not null and
   (case when campo='validade' then (to_jsonb(q)->>campo)::timestamptz is distinct from (p_campos->>campo)::timestamptz else (to_jsonb(q)->>campo)::numeric is distinct from (p_campos->>campo)::numeric end) and
   not (coalesce((evid->>('anexo_'||campo))::boolean,false) and not coalesce((p_campos->>'origem_anexo')::boolean,false)) and
   not (campo='validade' and q.validade<now() and evid ? 'validade') then
    update public.frete_consultas set ia_pausada=true,status='revisao',proposta_evidencias=evid||jsonb_build_object('conflito',jsonb_build_object('campo',campo,'mensagem',m.id)),atualizado_por='assistente_frete_conflito' where id=q.id returning * into q;
    update public.frete_envios set status='bloqueado',error_code='proposta_divergente' where consulta_id=q.id and status='fila';
    return to_jsonb(q);
  end if;
 end loop;
 if p_campos ? 'valor_total' then q.valor_total=(p_campos->>'valor_total')::numeric;evid=evid||jsonb_build_object('valor_total',m.id,'anexo_valor_total',coalesce((p_campos->>'origem_anexo')::boolean,false));end if;
 if p_campos ? 'prazo_dias' then q.prazo_dias=(p_campos->>'prazo_dias')::integer;evid=evid||jsonb_build_object('prazo_dias',m.id,'anexo_prazo_dias',coalesce((p_campos->>'origem_anexo')::boolean,false));end if;
 if p_campos ? 'validade' then q.validade=(p_campos->>'validade')::timestamptz;evid=evid||jsonb_build_object('validade',m.id,'anexo_validade',coalesce((p_campos->>'origem_anexo')::boolean,false));end if;
 if coalesce(q.protocolo,'')='' and p_campos ? 'protocolo' then q.protocolo=p_campos->>'protocolo';evid=evid||jsonb_build_object('protocolo',m.id);end if;
 if p_campos->>'taxas_inclusas'='true' then evid=evid||jsonb_build_object('taxas_inclusas',m.id);end if;
 done=coalesce(q.valor_total is not null and q.prazo_dias is not null and q.validade>now() and evid ? 'taxas_inclusas' and not coalesce((evid->>'anexo_valor_total')::boolean,false) and not coalesce((evid->>'anexo_prazo_dias')::boolean,false) and not coalesce((evid->>'anexo_validade')::boolean,false),false);
 update public.frete_consultas set valor_total=q.valor_total,prazo_dias=q.prazo_dias,validade=q.validade,protocolo=q.protocolo,proposta_evidencias=evid,completa=done,ia_pausada=done,status=case when done then 'recebida' else 'aguardando' end,atualizado_por='assistente_frete_progresso' where id=q.id returning * into q;
 update public.frete_envios set status='bloqueado',error_code='progresso_atualizado' where consulta_id=q.id and status='fila' and mensagem_id is not null;
 if done then update public.frete_envios set status='bloqueado',error_code='proposta_completa' where consulta_id=q.id and status='fila';end if;
 return to_jsonb(q);
end $$;
revoke all on function public.frete_registrar_progresso(uuid,uuid,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.frete_registrar_progresso(uuid,uuid,timestamptz,jsonb) to service_role;
-- Conversa pode precisar de mais de seis perguntas. Não remove guarda de loop.
do $$ declare body text;begin
 select pg_get_functiondef('public.frete_enfileirar_resposta(uuid,uuid,text)'::regprocedure) into body;
 if position('if n >= 24 then' in body)>0 then return;end if;
 if position('if n >= 6 then' in body)=0 then raise exception 'Contrato inesperado de limite';end if;
 execute replace(body,'if n >= 6 then','if n >= 24 then');
end $$;
commit;
