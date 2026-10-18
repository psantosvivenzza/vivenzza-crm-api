# Ranking de fretes: valores numéricos válidos

Comparar propostas convertia valores com Number sem validar tipo ou finitude.
Booleanos/arrays podiam virar preços ou prazos; Infinity entrava no ranking e
corrompia a média. Agora aceita somente number/string não vazia e finita,
preserva numeric do banco em texto e prazo zero. Preço também respeita o teto
de1e9 já usado em validarProposta, evitando overflow com dados fora do contrato.
Parser Number permanece igual ao da entrada; formatos exponenciais continuam
aceitos quando finitos e dentro do teto. Não é conversor de moeda com vírgula.

Dois testes novos falharam antes da correção; cobertura inclui tipos inválidos,
finitude, ausência, zero/negativos, prazo fracionário, preço excessivo e teto
positivo. Demais regras de ordenação, desempate, prazo desejado, validade e
propostas incompletas permanecem. Não é revalidação de todas as linhas do banco.

Somente função pura e fixtures: não grava propostas, não contata transportadora,
não ativa WhatsApp/IA/sync, não envia valores reais ou cria compromisso comercial.
Testes de domínio incluem import do SDK pelo assistente para respostas locais;
execução adicional bloqueia fetch e sockets, sem chamar o modelo ou rede.
