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
import dns from 'dns'

export async function resolverHostE01() {
  const nome = process.env.E01_HOST
  const reserva = process.env.E01_HOST_IP

  if (!nome) {
    if (reserva) return reserva
    throw new Error('E01_HOST não configurado (nem E01_HOST_IP como reserva).')
  }

  try {
    const { address } = await dns.promises.lookup(nome, { family: 4 })
    return address
  } catch (err) {
    if (reserva) return reserva
    // Sem reserva configurada, devolve o nome e deixa o pg falhar com a
    // mensagem original — esconder o erro aqui só atrasaria o diagnóstico.
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
