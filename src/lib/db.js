import pg from 'pg'

const { Pool } = pg

// DATABASE_URL aceita tanto a connection string do Railway quanto a do Supabase:
// postgresql://postgres.[ref]:[senha]@aws-pooler.supabase.com:6543/postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
})

export const query = (text, params) => pool.query(text, params)

export default pool
