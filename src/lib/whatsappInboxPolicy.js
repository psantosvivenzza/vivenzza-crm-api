const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function inboxListPolicy(user, query) {
  const page = Number(query.page ?? 1)
  const limit = Number(query.pageSize ?? query.limit ?? 50)
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    return { error: 'Paginação inválida', status: 400 }
  }
  const requested = query.responsavel_id
  if (requested && requested !== 'sem_responsavel' && !UUID.test(requested)) return { error: 'Responsável inválido', status: 400 }
  if (user.role === 'vendedor' && requested && requested !== user.id) return { error: 'Acesso negado à carteira solicitada', status: 403 }
  return {
    page, limit, offset: (page - 1) * limit,
    responsible: user.role === 'vendedor' ? user.id : requested || null,
    activityOrder: query.ordenacao === 'ultima_mensagem',
  }
}
