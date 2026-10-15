// Inject an already-configured server-side pg Pool/Client. Never reads .env.
export function createCampaignProposalStore(db) {
  return {
    async get(id) {
      const { rows } = await db.query('SELECT record FROM campaign_review.proposals WHERE id=$1', [id])
      return rows[0]?.record ?? null
    },
    async list() {
      const { rows } = await db.query('SELECT record FROM campaign_review.proposals ORDER BY created_at DESC,id DESC LIMIT 100')
      return rows.map((r) => r.record)
    },
    async insert(record) {
      const r = await db.query('INSERT INTO campaign_review.proposals(id,revision,state,record) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(id) DO NOTHING', [record.id, record.revision, record.state, JSON.stringify(record)])
      return r.rowCount === 1
    },
    async compareAndSwap(id, revision, record) {
      try {
        const r = await db.query('UPDATE campaign_review.proposals SET revision=$3,state=$4,record=$5::jsonb WHERE id=$1 AND revision=$2', [id, revision, record.revision, record.state, JSON.stringify(record)])
        return r.rowCount === 1
      } catch (error) {
        if (error.code === '23505' && error.constraint === 'campaign_review_single_active_target') return false
        throw error
      }
    },
  }
}
