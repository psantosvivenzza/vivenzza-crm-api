import cors from 'cors'

const origensPermitidas = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:5173']

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    // Permite requisições sem origin (ex: Postman, mobile)
    if (!origin) return callback(null, true)
    if (origensPermitidas.includes(origin)) return callback(null, true)
    callback(new Error(`CORS: origem não permitida — ${origin}`))
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
})
