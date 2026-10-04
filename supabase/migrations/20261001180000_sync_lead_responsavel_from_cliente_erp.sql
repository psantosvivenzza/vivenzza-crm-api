-- ACHADO 2026-10-01: vendedores relataram clientes que não eram deles aparecendo
-- no Pipeline. Causa raiz: backfill copiou clientes_erp.vendedor_responsavel_usuario_id
-- (carteira histórica importada do NetVision, muitas vezes desatualizada) direto
-- pra leads.responsavel_id, sem checar se o vendedor ainda está ativo.
--
-- Decisão do Quais (padrão NetVision confirmado): seguir
-- clientes_erp.vendedor_responsavel_usuario_id como fonte de verdade do
-- "representante" do cliente, MAS só refletir isso em leads.responsavel_id
-- (o que controla visibilidade no Pipeline do vendedor) quando esse vendedor
-- estiver ativo e disponível. Cliente sem vendedor ativo definido fica sem
-- responsável (só admin vê) até alguém designar/transferir explicitamente.
--
-- Esse trigger garante que isso valha sempre, automaticamente, não importa
-- qual caminho (endpoint PUT /clientes/:id/vendedor, script de sync, edição
-- direta no banco etc.) altere vendedor_responsavel_usuario_id.

create or replace function public.fn_sync_lead_responsavel_from_cliente_erp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_novo_responsavel uuid;
begin
  if NEW.vendedor_responsavel_usuario_id is not null then
    select id into v_novo_responsavel
    from usuarios
    where id = NEW.vendedor_responsavel_usuario_id
      and ativo = true
      and disponivel_como_vendedor = true;
  end if;

  update leads
  set responsavel_id = v_novo_responsavel,
      updated_at = now()
  where cliente_erp_id = NEW.legacy_id
    and origem = 'erp_legado'
    and responsavel_id is distinct from v_novo_responsavel;

  return NEW;
end;
$$;

create or replace trigger trg_clientes_erp_sync_vendedor
after insert or update of vendedor_responsavel_usuario_id on public.clientes_erp
for each row
execute function public.fn_sync_lead_responsavel_from_cliente_erp();
