-- Quando o cliente pede atendente, o robo PROMETE que alguem retorna. A tarefa
-- ja e criada; faltava o outro lado: registrar o que aconteceu no retorno, e
-- fazer esse retorno CONTAR para a regua de tentativas.
--
-- Sem isto, a regua le so as ligacoes que o ROBO fez. Um retorno humano nao
-- conta como contato, entao o robo pode ligar de novo amanha para o cliente
-- com quem a atendente acabou de falar - inclusive para quem ja prometeu pagar,
-- que e o jeito mais rapido de perder um cliente bom.
alter table public.voice_calls
  add column if not exists retorno_humano_em          timestamptz,
  add column if not exists retorno_humano_desfecho    text,
  add column if not exists retorno_humano_por         uuid references public.usuarios(id),
  add column if not exists retorno_humano_observacao  text,
  -- Contato humano efetivo entra no MESMO calculo de "atendida" da regua, sem
  -- mexer no status da ligacao original: se a ligacao caiu na caixa postal e a
  -- pessoa so foi alcancada depois, o painel deve continuar dizendo "caixa
  -- postal" (foi o que aconteceu ao telefone) e a regua deve contar o contato.
  add column if not exists contato_humano_efetivo     boolean not null default false,
  add column if not exists tarefa_id                  uuid references public.tarefas(id);

create index if not exists idx_voice_calls_retorno_pendente
  on public.voice_calls (started_at desc)
  where requires_human = true and retorno_humano_em is null;

comment on column public.voice_calls.contato_humano_efetivo is
  'Um humano falou de fato com o cliente neste caso. Entra no calculo de "atendida" da regua (trava de 7 dias), sem alterar o status da ligacao original.';
