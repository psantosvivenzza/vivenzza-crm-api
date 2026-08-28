# Contexto do projeto para o Claude Code

Índice da documentação de contexto do CRM Vivenzza. Existe para que
qualquer sessão nova (ou qualquer pessoa) entenda rapidamente o estado
atual, as decisões já tomadas e o que nunca deve ser refeito ou revertido
por engano.

## Leia nesta ordem

1. [`CLAUDE.md`](../../CLAUDE.md) (raiz do repo) — regras operacionais curtas.
2. [`arquitetura-geral.md`](arquitetura-geral.md) — visão geral do sistema.
3. [`decisoes-importantes.md`](decisoes-importantes.md) — decisões que não
   devem ser esquecidas nem revertidas sem entender o motivo original.
4. O documento do **domínio da tarefa atual**:
   - [`cobranca-whatsapp.md`](cobranca-whatsapp.md) — motor de cobrança,
     WhatsApp financeiro, DNC, quarentena.
   - [`fiscal-e-vendas.md`](fiscal-e-vendas.md) — pedidos, vendas
     gerenciais, fiscal, certificado digital.
   - [`voice.md`](voice.md) — voz/IA, Asterisk, servidor de voz.
5. [`tarefas-pendentes.md`](tarefas-pendentes.md) — o que falta, o que já
   foi concluído.
6. [`historico-prs.md`](historico-prs.md) — quando precisar de contexto
   histórico de uma decisão específica (qual PR fez o quê).

## Regra de ouro

Se esta documentação divergir do código atual: **o código em `origin/main`
é a verdade**, nunca o texto aqui. Isso acontece — documentação sempre
atrasa em relação ao código. Ao encontrar uma divergência, confirme no
código real antes de agir, e **atualize o documento junto da PR** que
mudar a decisão (não depois, em uma PR separada "de documentação" que
nunca chega a acontecer).

## O que este índice NÃO é

Não é um substituto para ler o código. É contexto de alto nível para
orientar por onde começar e quais decisões já foram tomadas — os detalhes
de implementação sempre vivem no código e nos testes.
