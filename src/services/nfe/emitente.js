import { readFileSync } from 'fs'

// Dados fixos do emitente — LD SUL COSMÉTICOS LTDA
export const EMITENTE = {
  CNPJ: '13602526000193',
  xNome: 'L&L SANTOS COSMETICOS LTDA',
  xFant: 'VIVENZZA',
  IE: '0240611101',
  CRT: '1',          // 1=Simples Nacional
  // Endereço
  xLgr: 'RUA ITU',
  nro: '139',
  xBairro: 'IGARA',
  cMun: '4304606',   // Canoas/RS
  xMun: 'CANOAS',
  UF: 'RS',
  CEP: '92410130',
  cPais: '1058',
  xPais: 'BRASIL',
  fone: '',
  // Certificado — caminho de rede local (DESKTOP-Q6O54R1), só alcançável de máquinas
  // na mesma LAN. Usado como fallback de desenvolvimento por getCertBuffer() abaixo —
  // em produção (Railway) o certificado vem de CERT_BASE64, não deste caminho.
  // Senha nunca vai pro código — vem de NFE_CERT_SENHA (Railway → Variables, secret).
  //
  // CORRIGIDO (higiene) — o default anterior aqui era o nome real do arquivo de
  // homologação, que tinha a senha do certificado escrita literalmente
  // (".../LL_SANTOS_COSMETICOS_LTDA13602526000193 senha 123456.pfx"), expondo a
  // senha em texto aberto neste arquivo versionado no git. Sem fallback com
  // segredo embutido agora — quem quiser usar o caminho de rede em dev PRECISA
  // setar NFE_CERT_PATH explicitamente (getCertBuffer() abaixo lança erro claro
  // se nem CERT_BASE64 nem NFE_CERT_PATH estiverem setados, em vez de herdar um
  // caminho com senha). Renomear o arquivo real na pasta de rede (removendo a
  // senha do nome) continua recomendado, mas não é mais uma dependência do código.
  CERT_PATH: process.env.NFE_CERT_PATH || null,
  CERT_SENHA: process.env.NFE_CERT_SENHA,
}

// Bytes do .pfx — prioriza CERT_BASE64 (Railway → Variables), que é o único jeito do
// Railway acessar o certificado já que CERT_PATH é um caminho de rede local
// inatingível da nuvem. Só cai para o arquivo local se CERT_BASE64 não estiver
// setada, o que mantém isso funcionando em desenvolvimento local na mesma LAN do
// DESKTOP-Q6O54R1 — desde que NFE_CERT_PATH esteja setada explicitamente (sem
// fallback com segredo embutido no código, ver comentário em CERT_PATH acima).
export function getCertBuffer() {
  if (process.env.CERT_BASE64) {
    return Buffer.from(process.env.CERT_BASE64, 'base64')
  }
  if (!EMITENTE.CERT_PATH) {
    throw new Error('Certificado não configurado: defina CERT_BASE64 (produção/Railway) ou NFE_CERT_PATH (dev local, caminho do .pfx na rede) — nenhum caminho padrão é assumido.')
  }
  return readFileSync(EMITENTE.CERT_PATH)
}

// Configurações SEFAZ para RS (SVRS)
export const SEFAZ = {
  UF: 'RS',
  cUF: 43,
  // Ambiente: 1=Produção, 2=Homologação. Controlado por NFE_AMBIENTE (Railway →
  // Variables) — default é SEMPRE homologação mesmo se a env var não existir ou
  // vier com um valor inesperado; só um "producao" explícito e exato liga o
  // ambiente real. Isso é proposital: a troca pra produção é uma decisão de
  // negócio (numeração da série 1 fiscal ainda não definida com o contador —
  // ver migrations/nfe_configuracoes_fiscais.sql), nunca deve acontecer por
  // omissão de configuração.
  tpAmb: process.env.NFE_AMBIENTE === 'producao' ? '1' : '2',
  versao: '4.00',
  // Endpoints — domínio CORRETO é sefazrs.rs.gov.br (infra própria da SEFAZ-RS pro
  // cUF=43), não svrs.rs.gov.br (SVRS = Sefaz Virtual que a RS opera como serviço de
  // CONTINGÊNCIA pra outros estados contratantes — daí o cStat 410 "UF informada no
  // campo cUF nao e atendida", confirmado com teste diferencial: cUF=41/PR funcionava
  // no domínio svrs.rs.gov.br, cUF=43/RS não).
  // statusServico validado de verdade (cStat 107 "Servico em Operacao", testado via
  // railway run contra o domínio sefazrs.rs.gov.br). Os outros 4 endpoints de
  // homologação seguem o mesmo domínio confirmado por fonte externa (nfephp-org/
  // sped-nfe, lib PHP de NFe amplamente usada), mas não foram testados
  // individualmente um a um.
  endpoints: {
    homologacao: {
      nfe: {
        autorizacao: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
        retAutorizacao: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
        inutilizacao: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
        consultaProtocolo: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
        statusServico: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
        // Serviço unificado de eventos do NFe 4.00 (recepcaoevento4.asmx) — o xmlns de
        // nfeDadosMsg em montarEnvelopeCancelamento() (sefaz.js) foi corrigido pra
        // ".../RecepcaoEvento4" (era ".../NfeCancelamento4", serviço antigo
        // descontinuado). Ainda não testado contra a SEFAZ de verdade — só
        // statusServico foi validado empiricamente até agora. Testar em homologação
        // antes do 1º cancelamento real.
        cancelamento: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
      },
    },
    // Mesmo domínio (sefazrs.rs.gov.br) aplicado por consistência com o padrão
    // confirmado em homologação — NÃO testado empiricamente em produção.
    producao: {
      nfe: {
        autorizacao: 'https://nfe.sefazrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
        retAutorizacao: 'https://nfe.sefazrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
        inutilizacao: 'https://nfe.sefazrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
        consultaProtocolo: 'https://nfe.sefazrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
        statusServico: 'https://nfe.sefazrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
        cancelamento: 'https://nfe.sefazrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
      },
    },
  },
  get urls() {
    return this.tpAmb === '1' ? this.endpoints.producao.nfe : this.endpoints.homologacao.nfe
  },
}
