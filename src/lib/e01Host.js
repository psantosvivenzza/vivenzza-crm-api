// Resolução do host do NetVision (banco e01), num lugar só.
//
// PROBLEMA REAL (18/09/2026): `E01_HOST=DESKTOP-Q6O54R1` é um nome de máquina
// Windows, não um nome de DNS. Quem responde por ele é mDNS/LLMNR na rede
// local, e isso tem duas consequências que aparecem nos logs de TODOS os
// syncs, todo dia:
//
//   1. A resolução devolve IPv6 link-local (fe80::…) na frente do IPv4. Esse
//      endereço só vale dentro do escopo da interface e não serve para
//      conectar num Postgres que escuta em IPv4.
//   2. mDNS falha de vez em quando, sem motivo permanente — daí os
//      `getaddrinfo ENOTFOUND DESKTOP-Q6O54R1` intermitentes. A máquina está
//      lá, ligada, respondendo ping; só o nome não resolveu naquele instante.
//      Medido em 18/09/2026: 8 resoluções seguidas falharam enquanto o banco
//      atendia normalmente por IP. Não é raro — é frequente.
//
// A máquina do NetVision tem DUAS interfaces de rede: 192.168.1.105 e
// 192.168.1.108 atendem o MESMO banco e01 (verificado consultando as duas).
// Por isso o nome às vezes responde um e às vezes outro, e por isso cachear
// o endereço é seguro: qualquer um dos dois é a máquina certa.
//
// O efeito prático é sync perdendo janela e recuperando na tentativa
// seguinte. Barulhento, e no caso do financeiro chega a pausar a régua de
// cobrança por atraso de sincronização.
//
// SOLUÇÃO, em duas camadas:
//
//   - `family: 4` na resolução: pede IPv4 explicitamente, nunca o
//     link-local. Resolve o problema 1 inteiro.
//   - `E01_HOST_IP` como rede de segurança: se o nome não resolver naquele
//     instante, usa o IP conhecido. Resolve o problema 2.
//
// Por que NÃO trocar o `E01_HOST` pelo IP direto e encerrar o assunto: o IP
// vem de DHCP e pode mudar sozinho. Mantendo o NOME como fonte primária, uma
// troca de IP se resolve sozinha; o IP fixo só entra quando o nome falha.
// As duas coisas juntas cobrem os dois modos de falha — nenhuma das duas
// sozinha cobre.
//
// Quando o host já é um IP literal, `dns.lookup` devolve ele mesmo: este
// módulo continua correto sem nenhum caso especial.
//
// CACHE DO ÚLTIMO IP BOM: toda resolução bem-sucedida grava o endereço em
// disco. Quando o nome falha, o cache é tentado ANTES do `E01_HOST_IP` fixo.
// É isso que faz uma troca de IP por DHCP se resolver sozinha: basta o nome
// ter resolvido uma vez depois da troca — coisa que acontece em minutos, já
// que a falha de mDNS é intermitente, não permanente. Sem o cache, uma troca
// de IP deixaria a reserva do `.env` apontando para o endereço errado, o que
// é pior do que não ter reserva: falha com a aparência de configurada.
import dns from 'dns'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ARQUIVO_CACHE = path.join(__dirname, '..', '..', '.localdev', 'e01-host-cache.json')

function lerCache(nome) {
  try {
    const dados = JSON.parse(fs.readFileSync(ARQUIVO_CACHE, 'utf8'))
    // O cache é por NOME: se alguém trocar o E01_HOST, o endereço guardado
    // para o host anterior não vale mais.
    return dados?.host === nome ? dados.ip : null
  } catch {
    return null
  }
}

function gravarCache(nome, ip) {
  try {
    if (lerCache(nome) === ip) return // nada mudou, não escreve à toa
    fs.mkdirSync(path.dirname(ARQUIVO_CACHE), { recursive: true })
    fs.writeFileSync(ARQUIVO_CACHE, JSON.stringify({ host: nome, ip, em: new Date().toISOString() }, null, 2))
  } catch {
    // Cache é conveniência, nunca requisito: disco cheio ou sem permissão
    // não pode derrubar um sync.
  }
}

export async function resolverHostE01() {
  const nome = process.env.E01_HOST
  const reserva = process.env.E01_HOST_IP

  if (!nome) {
    if (reserva) return reserva
    throw new Error('E01_HOST não configurado (nem E01_HOST_IP como reserva).')
  }

  try {
    const { address } = await dns.promises.lookup(nome, { family: 4 })
    gravarCache(nome, address)
    return address
  } catch (err) {
    // Último IP que funcionou de verdade vem antes da reserva fixa: ele é o
    // mais recente dos dois, e é o único que acompanha troca de DHCP.
    const doCache = lerCache(nome)
    if (doCache) return doCache
    if (reserva) return reserva
    // Sem cache e sem reserva, devolve o erro original — esconder aqui só
    // atrasaria o diagnóstico.
    throw err
  }
}

/**
 * Config de conexão pronta para `new pg.Pool(...)` / `new pg.Client(...)`.
 * É async de propósito: a resolução acontece ANTES de o pg abrir o socket,
 * que é o único ponto onde dá para escolher a família e aplicar a reserva.
 */
export async function configE01({ connectionTimeoutMillis = 8000, ...extra } = {}) {
  return {
    host: await resolverHostE01(),
    port: process.env.E01_PORT,
    user: process.env.E01_USER,
    password: process.env.E01_PASSWORD,
    database: process.env.E01_DATABASE,
    connectionTimeoutMillis,
    ...extra,
  }
}
