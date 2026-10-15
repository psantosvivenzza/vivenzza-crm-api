import {resumirLogistica,calcularLogisticaPedido} from './logistica.js'
export {resumirLogistica} from './logistica.js'
import {FreteError} from './domain.js'
import {EMITENTE} from '../../services/nfe/emitente.js'
const positive=v=>v!=null && v!=='' && Number.isFinite(Number(v)) && Number(v)>0
const norm=v=>String(v??'').trim().toUpperCase()
export function validarBuscaPedido(numero, filial='') {
 if(!/^\d{1,10}$/.test(String(numero)) || Number(numero)<1 || Number(numero)>2147483647) throw new FreteError('Informe um número de pedido válido.')
 if(filial && !/^\d{1,3}$/.test(String(filial))) throw new FreteError('Filial: informe até três dígitos.')
 return {numero:String(Number(numero)),filial:filial ? String(filial):''}
}
export function validarPedidoImportavel(pedido) {
 if(pedido.status==='cancelado')throw new FreteError('Pedido cancelado não pode originar cotação.',409)
 if(pedido.status_importacao_pendente || pedido.erro_sincronizacao || pedido.conflito_sincronizacao)throw new FreteError('Pedido com pendência de sincronização. Resolva a pendência antes de importar.',409)
}
export function prepararPedidoFrete(pedido, cliente, snapshot=pedido.frete_logistica, emitente=EMITENTE) {
 validarPedidoImportavel(pedido)
 const calculada=calcularLogisticaPedido({...pedido,frete_logistica:snapshot})
 const {peso_origem:peso,cubagem_origem:cubagem,avisos}=calculada
 const e=cliente?.endereco||{}
 const entrega={nome:cliente?.razao_social||pedido.cliente_nome_origem||'',cnpj:cliente?.cnpj_cpf||pedido.cliente_documento_origem||'',cep:e.cep||'',endereco:[e.logradouro,e.numero,e.complemento,e.bairro,e.cidade,e.uf].filter(Boolean).join(', ')}
 const retirada={nome:emitente.xNome,cnpj:emitente.CNPJ,cep:emitente.CEP,endereco:[emitente.xLgr,emitente.nro,emitente.xBairro,emitente.xMun,emitente.UF].filter(Boolean).join(', ')}
 const pesoTotal=positive(pedido.peso_bruto) ? Number(pedido.peso_bruto):calculada.peso_bruto_kg
 if(!cliente || !entrega.cep || !entrega.endereco)avisos.push('Cliente ou endereço incompleto no pedido. Confira o destinatário e o endereço real de entrega.')
 avisos.push('Retirada e pagador foram sugeridos pelo cadastro da empresa. Confira a filial e o local real de retirada.')
 avisos.push('Valor importado é o total comercial do pedido, não uma NF-e confirmada. Confira o valor da mercadoria e eventuais entregas parciais.')
 if(!pedido.qtde_volumes)avisos.push('Quantidade de volumes não informada na origem. Preencha a quantidade embalada.')
 return {sugestoes_logistica:{peso_produtos:peso,cubagem_produtos:cubagem},pedido:{id:pedido.id,referencia:pedido.legacy_id,sincronizado_em:pedido.sincronizado_em,logistica_em:snapshot?.consultado_em||null},dados:{descricao:`Pedido NetVision ${pedido.legacy_id}`,valor_mercadoria:positive(pedido.total)?Number(pedido.total):'',peso_kg:pesoTotal??'',modo_volumes:'cubagem_total',cubagem_m3:calculada.cubagem_m3??'',quantidade_volumes:positive(pedido.qtde_volumes)?Number(pedido.qtde_volumes):'',volumes:[],retirada,entrega,pagador:{nome:retirada.nome,cnpj:retirada.cnpj},pedido_origem:{id:pedido.id,referencia:pedido.legacy_id},dados_importados_conferidos:false},avisos}
}
