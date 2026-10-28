-- Respostas a perguntas atuais precedem abertura/retomada de outros contatos.
-- Mantém FIFO dentro de cada consulta, cadência, locks, escopo e permissões.
create or replace function public.frete_proximo_envio() returns setof public.frete_envios
language plpgsql security invoker set search_path='' as $$
declare e public.frete_envios;q public.frete_consultas;cid uuid;referencia boolean;
begin
 if not pg_try_advisory_xact_lock(78141014) then return;end if;
 for e in select s.* from public.frete_envios s join public.frete_consultas a on a.id=s.consulta_id
  join public.frete_cotacoes c on c.id=a.cotacao_id
  left join public.frete_mensagens m on m.id=s.mensagem_id and m.consulta_id=s.consulta_id
  where s.status='fila' and c.status='aberta' and not a.ia_pausada and not a.contato_liberado
   and a.status not in('rascunho','encerrada')
   and not exists(select 1 from public.frete_envios older where older.consulta_id=s.consulta_id and older.status='fila' and (older.created_at,older.id)<(s.created_at,s.id))
  order by case when m.direcao='entrada' and m.created_at>=s.created_at-interval '5 minutes'
   and s.texto not like 'Olá! Sou o assistente de cotações da Vivenzza. Solicitação de frete FRETE-%' then 0 else 1 end,s.created_at,s.id loop
  select cotacao_id into cid from public.frete_consultas where id=e.consulta_id;
  perform 1 from public.frete_cotacoes where id=cid and status='aberta' for update;
  if not found then continue;end if;
  select * into q from public.frete_consultas where id=e.consulta_id for update;
  if q.ia_pausada or q.contato_liberado or q.status in('rascunho','encerrada') then continue;end if;
  if exists(select 1 from public.frete_consultas a where a.id<>q.id and a.instance_name=q.instance_name
   and public.frete_contato_chave(a.telefone)=public.frete_contato_chave(q.telefone)
   and a.status not in('rascunho','encerrada') and not a.contato_liberado and not a.aguarda_contato) then continue;end if;
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
