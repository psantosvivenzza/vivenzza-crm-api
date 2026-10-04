-- ACHADO 2026-10-01 (continuação do trigger de sync responsavel_id):
-- decisão do Quais: "você puxa do netvision o vendedor responsável e apos
-- isso quando tiver mudanças alteramos". O sync de clientes (NetVision)
-- grava representante_nome (texto cru) só na criação do cliente; nunca
-- atualizava depois, e nada resolvia esse texto pro
-- vendedor_responsavel_usuario_id automaticamente — essa resolução dependia
-- de um processo histórico fora do código atual (com erros conhecidos, ex.:
-- legacy_id 002043 "Wilian" vs "Ana").
--
-- Esta migração fecha esse ciclo:
-- 1) tabela de mapeamento nome-do-representante-no-NetVision -> usuário
--    interno (curada, seedada a partir do vínculo majoritário já existente
--    e confiável hoje em clientes_erp);
-- 2) flag vendedor_atribuicao_manual: uma transferência feita pela tela
--    "Troca de representante" (PUT /clientes/:id/vendedor) trava o cliente
--    pra sempre contra sobrescrita automática do sync — representante no
--    NetVision pode continuar apontando pro nome antigo, não importa;
-- 3) trigger BEFORE que resolve vendedor_responsavel_usuario_id a partir de
--    representante_nome (só quando NÃO travado manualmente);
-- 4) o trigger de propagação pra leads.responsavel_id (criado na migração
--    anterior, 20261001180000) é ampliado de "UPDATE OF
--    vendedor_responsavel_usuario_id" pra "INSERT OR UPDATE" sem filtro de
--    coluna — porque o Postgres decide se um trigger "OF coluna" dispara
--    pela cláusula SET do comando ORIGINAL, não pelo valor final após
--    triggers BEFORE. Sem isso, uma mudança em representante_nome resolvida
--    pelo trigger (3) não propagaria pro lead.
--
-- O job de sync (src/jobs/sync-clientes-legado.js) foi alterado em paralelo
-- pra também atualizar representante_nome de clientes já existentes quando
-- o NetVision muda (antes só gravava na criação) — é isso que alimenta o
-- trigger (3) continuamente.

alter table public.clientes_erp
  add column if not exists vendedor_atribuicao_manual boolean not null default false;

create table if not exists public.representante_vendedor_mapa (
  representante_nome_norm text primary key,
  usuario_id uuid not null references public.usuarios(id),
  observacao text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- Seed: vendedor majoritário já associado hoje a cada representante_nome
-- (fonte confiável pros casos já corretos, confirmado pelo Quais).
insert into public.representante_vendedor_mapa (representante_nome_norm, usuario_id, observacao)
select lower(trim(representante_nome)) as chave, vendedor_responsavel_usuario_id,
  'seed automático 2026-10-01 a partir do vínculo majoritário existente'
from (
  select representante_nome, vendedor_responsavel_usuario_id,
    count(*) as qtd,
    row_number() over (partition by lower(trim(representante_nome)) order by count(*) desc) as rn
  from clientes_erp
  where representante_nome is not null and trim(representante_nome) <> ''
    and vendedor_responsavel_usuario_id is not null
  group by representante_nome, vendedor_responsavel_usuario_id
) ranked
where rn = 1
on conflict (representante_nome_norm) do nothing;

create or replace function public.fn_resolver_vendedor_por_representante()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_usuario_id uuid;
begin
  if NEW.vendedor_atribuicao_manual then
    return NEW;
  end if;

  if NEW.representante_nome is not null then
    select usuario_id into v_usuario_id
    from representante_vendedor_mapa
    where representante_nome_norm = lower(trim(NEW.representante_nome));

    if v_usuario_id is not null then
      NEW.vendedor_responsavel_usuario_id := v_usuario_id;
    end if;
  end if;

  return NEW;
end;
$$;

create or replace trigger trg_clientes_erp_resolver_vendedor
before insert or update of representante_nome on public.clientes_erp
for each row
execute function public.fn_resolver_vendedor_por_representante();

create or replace trigger trg_clientes_erp_sync_vendedor
after insert or update on public.clientes_erp
for each row
execute function public.fn_sync_lead_responsavel_from_cliente_erp();
