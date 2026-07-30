import 'dotenv/config'
import { supabase } from '../src/lib/supabase.js'

const { data: p1 } = await supabase.from('pedidos').select('id, observacoes, legacy_id').or('observacoes.ilike.%TESTE%,legacy_id.ilike.%TESTE%')
console.log('pedidos residuais de teste:', JSON.stringify(p1))

const { data: h1 } = await supabase.from('pedido_historico').select('id, campo').ilike('valor_novo', '%TESTE%')
console.log('historico residual de teste:', JSON.stringify(h1))
