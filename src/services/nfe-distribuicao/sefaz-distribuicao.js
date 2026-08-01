// Cliente SOAP do webservice NACIONAL NFeDistribuicaoDFe — AINDA NÃO
// IMPLEMENTADO. Bloqueado por dois motivos, nessa ordem:
//
// 1. O certificado digital atual da Vivenzza expira em 12/08/2026 (ver
//    Fase_B_Scoping.md) — não faz sentido implementar e testar contra um
//    certificado que vai vencer em poucos dias. Aguardando renovação.
// 2. Mesmo com certificado válido, a assinatura XML-DSig do corpo da
//    consulta (se exigida por este serviço específico — ainda não
//    confirmado por nenhuma fonte pesquisada; serviços de CONSULTA às vezes
//    dispensam assinatura, diferente dos de ENVIO) precisa ser validada em
//    homologação antes de qualquer chamada real.
//
// O que ESTE arquivo faz até lá: mantém o formato de chamada estável (mesma
// assinatura de função que o job em jobs/nfe-distribuicao-sync.js já
// espera), documenta os endpoints e o envelope confirmados pela pesquisa de
// 01/08/2026, e lança um erro claro e específico em vez de silenciosamente
// devolver dados falsos.
//
// Endpoints confirmados (pesquisa 01/08/2026 — Distribuição DF-e é serviço
// do AMBIENTE NACIONAL, domínio nfe.fazenda.gov.br, DIFERENTE dos endpoints
// de emissão que são específicos da SEFAZ-RS/sefazrs.rs.gov.br):
//   homologação: https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx
//   produção:    https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx
//   método SOAP: nfeDistDFeInteresse, versão do serviço 1.01
//
// Regra de throttling (NT 2014.002) já implementada e testada em cursor.js —
// este arquivo, quando implementado, DEVE ser chamado só depois de
// `podeConsultar()` (via ciclo.js) autorizar.
export const ENDPOINTS_DISTRIBUICAO_DFE = {
  homologacao: 'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
  producao: 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
}

// cnpj: CNPJ interessado (da Vivenzza, não do fornecedor — a distribuição é
// por destinatário/interessado, não por remetente).
// ultNSU: string de 15 dígitos, o cursor atual (ciclo.js já decide qual usar).
// ambiente: 'homologacao' | 'producao'.
export async function consultarDistribuicaoDFe({ cnpj, ultNSU, ambiente }) {
  throw new Error(
    'consultarDistribuicaoDFe: chamada SOAP real ainda não implementada — ' +
    'aguardando renovação do certificado digital (expira 12/08/2026) e ' +
    'validação da assinatura XML-DSig em homologação. Ver Fase_B_Scoping.md.'
  )
}
