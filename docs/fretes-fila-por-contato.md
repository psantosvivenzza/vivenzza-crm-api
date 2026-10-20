# Cotação e atendimento são ciclos separados

É permitido criar várias cotações abertas, inclusive para o mesmo contato.
Salvar não envia mensagens. Solicitar WhatsApp reserva o atendimento livre ou
coloca a consulta em espera. O worker pula contatos ocupados: não bloqueia outras
transportadoras. O claim serializado e a cadência de60s continuam obrigatórios.

## Operação

- `aguarda_contato`: solicitação aguarda outro atendimento no mesmo WhatsApp.
- `contato_liberado`: atendimento finalizado explicitamente pelo operador, sem
  encerrar a cotação nem apagar proposta, mensagens ou reservas. Não reabre nem
  reinicia menus externos; não permite retry da reserva antiga.
- Finalizar atendimento bloqueia respostas ainda na fila e mantém a IA pausada
  nessa consulta. Resultado de envio em andamento/incerto impede liberação.
- Pausa humana/recusa/opt-out não libera automaticamente o contato.

## Respostas tardias

Depois de reutilizar um contato, o sistema exige UUID da cotação ou reply-to de
mensagem enviada na sessão atual. Sem essa referência, NÃO adivinha pelo horário,
rota mencionada ou última cotação criada. Texto fica fora dos históricos de
cotação em `frete_respostas_pendentes`, e o atendimento é pausado para revisão.
Também preserva mensagens no intervalo entre liberar e promover a próxima sessão.

O operador confirma contato/cotação/trecho da mensagem na tela e associa a
resposta. A associação não interpreta preço nem responde à transportadora; a
proposta continua sendo conferida no formulário. Esta é uma limitação deliberada:
bot externo que não devolve referência exige assistência humana após reutilização.
Não foi prometida correlação automática perfeita de mensagens livres.

Mídia suportada é baixada exclusivamente da Evolution financeira, validada por
tipo/magic/hash/limite e preservada privadamente sem OCR automático. Após
associação, bytes e metadados são copiados ao anexo do histórico escolhido.
Reserva de download interrompida há mais de2min pode ser associada em revisão,
sem repetir download ou inventar conteúdo. Lista exibe até100 pendências antigas
por conjunto de contatos, sem expor bytes no JSON.

## Implantação e recuperação

Aplicar `20261020154037_frete_fila_por_transportadora.sql` ANTES da API nova e,
depois, publicar a interface. Migration é transacional, com lock_timeout5s e
statement_timeout60s; não muda flags, cotações, dinheiro ou cadência existente.
Dados existentes recebem flags false e preservam estados. O índice passa a
reservar apenas consultas iniciadas/ativas, excluindo rascunhos/espera/liberadas.

Não restaurar o índice antigo depois de criar concorrentes: ele falharia ou
exigiria encerramentos indevidos. Em incidente, preservar banco e reservas e
fazer correção adiante. API anterior pode ficar parada na cabeça em espera com
schema novo; não tratar esse rollback como retomada funcional da fila.

Erros do seletor registram somente código sanitizado. Resultado incerto não é
reenfileirado e também impede a próxima sessão naquele contato, mesmo se a
consulta antiga tiver sido encerrada. Outros contatos continuam elegíveis.

## Evidências locais exigidas

- Testes offline: correlação, opt-out, eco/reentrega antigos, sessão ativa versus
  espera, proposta completa preservada, mídia e falhas técnicas.
- Postgres sintético+API+inbound+worker/provedor falso: criar A/B abertas, outro
  contato avançar, liberar individualmente com CAS, corrida entre réplicas,
  FIFO, CAS estável por tick, resposta tardia fora da cotação, associação única,
  mídia privada e recuperação de reserva interrompida, privilégios service-only.
- Navegador com HTTP simulado: criar B dentro de A sem encerrar A, fila, cancelar
  confirmação, clique duplo, CAS409, atualização e associação, mobile360/390.
- Build frontend e revisão crítica Claude antes de publicar.

Testes sintéticos não são evidência de entrega/leitura ou proposta real de
transportadora. Publicação e validação real devem ser registradas separadamente.
