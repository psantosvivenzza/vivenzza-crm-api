// Widget de avaliações Vivenzza — formulário + listagem.
// Uso no tema Nuvemshop:
//   <script src="https://vivenzza-crm-api-production.up.railway.app/widgets/avaliacoes.js"
//           data-produto-id="{{ product.id }}"></script>
// (omita data-produto-id para o widget de avaliações gerais da loja)
(function () {
  var thisScript = document.currentScript
  var API_BASE = thisScript.getAttribute('data-api-base') || 'https://vivenzza-crm-api-production.up.railway.app'
  var produtoId = thisScript.getAttribute('data-produto-id') || ''

  function garantirFontes() {
    if (document.querySelector('link[data-vz-fontes]')) return
    var link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'https://fonts.googleapis.com/css2?family=Alumni+Sans:ital,wght@0,100..900;1,100..900&family=Inter+Tight:wght@300;400;500;600&display=swap'
    link.setAttribute('data-vz-fontes', '1')
    document.head.appendChild(link)
  }

  function garantirEstilos() {
    if (document.getElementById('vz-avaliacoes-style')) return
    var style = document.createElement('style')
    style.id = 'vz-avaliacoes-style'
    style.textContent = [
      '.vz-avaliacoes-widget{--vz-offwhite-1:#FFFAF5;--vz-offwhite-2:#F5EAE1;--vz-offwhite-3:#E6DCD4;--vz-cinza-4:#D9CFC8;--vz-cinza-5:#C9C1B9;--vz-chumbo:#242221;--vz-text-muted:#6B6560;box-sizing:border-box;max-width:640px;margin:0 auto;font-family:"Inter Tight",sans-serif;color:var(--vz-chumbo);}',
      '.vz-avaliacoes-widget *{box-sizing:border-box;}',
      '.vz-av-titulo{font-family:"Alumni Sans",sans-serif;font-size:clamp(24px,3vw,32px);font-weight:800;text-transform:uppercase;letter-spacing:-0.3px;margin:0 0 16px;}',
      '.vz-av-resumo{display:flex;align-items:center;gap:10px;margin-bottom:24px;}',
      '.vz-av-resumo .vz-av-media{font-family:"Alumni Sans",sans-serif;font-size:28px;font-weight:800;}',
      '.vz-av-resumo .vz-av-total{font-size:13px;color:var(--vz-text-muted);}',
      '.vz-av-estrelas{color:var(--vz-chumbo);letter-spacing:2px;font-size:16px;}',
      '.vz-av-form{background:var(--vz-offwhite-2);border:1px solid var(--vz-cinza-4);border-radius:10px;padding:20px;margin-bottom:28px;}',
      '.vz-av-form label{display:block;font-size:12px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--vz-text-muted);margin-bottom:6px;}',
      '.vz-av-form input,.vz-av-form textarea{width:100%;font-family:"Inter Tight",sans-serif;font-size:14px;padding:10px 12px;border:1px solid var(--vz-cinza-4);border-radius:8px;background:var(--vz-offwhite-1);color:var(--vz-chumbo);margin-bottom:16px;outline:none;}',
      '.vz-av-form textarea{resize:vertical;min-height:80px;}',
      '.vz-av-estrelas-input{display:flex;gap:4px;margin-bottom:16px;}',
      '.vz-av-estrelas-input button{background:none;border:none;cursor:pointer;font-size:26px;line-height:1;color:var(--vz-cinza-5);padding:0;}',
      '.vz-av-estrelas-input button.ativa{color:var(--vz-chumbo);}',
      '.vz-av-btn{display:inline-block;background:var(--vz-chumbo);color:var(--vz-offwhite-1);font-family:"Alumni Sans",sans-serif;font-size:15px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;border:none;padding:12px 28px;border-radius:8px;cursor:pointer;transition:opacity .2s;}',
      '.vz-av-btn:hover{opacity:.85;}',
      '.vz-av-btn:disabled{opacity:.5;cursor:not-allowed;}',
      '.vz-av-msg{font-size:13px;margin-top:10px;}',
      '.vz-av-msg.erro{color:#B42318;}',
      '.vz-av-msg.sucesso{color:#1B7F4C;}',
      '.vz-av-lista{display:flex;flex-direction:column;gap:16px;}',
      '.vz-av-item{border-bottom:1px solid var(--vz-cinza-4);padding-bottom:16px;}',
      '.vz-av-item-topo{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;}',
      '.vz-av-item-nome{font-weight:600;font-size:14px;}',
      '.vz-av-item-data{font-size:12px;color:var(--vz-text-muted);}',
      '.vz-av-item-comentario{font-size:14px;line-height:1.5;margin-top:6px;}',
      '.vz-av-vazio{font-size:13px;color:var(--vz-text-muted);}',
    ].join('')
    document.head.appendChild(style)
  }

  function escapeHtml(str) {
    var div = document.createElement('div')
    div.textContent = str == null ? '' : String(str)
    return div.innerHTML
  }

  function estrelasTexto(nota) {
    return '★★★★★☆☆☆☆☆'.slice(5 - nota, 10 - nota)
  }

  function formatarData(iso) {
    try {
      return new Date(iso).toLocaleDateString('pt-BR')
    } catch (e) {
      return ''
    }
  }

  function montarUrl(caminho) {
    var url = API_BASE + caminho
    if (produtoId) url += (url.indexOf('?') === -1 ? '?' : '&') + 'produto_id=' + encodeURIComponent(produtoId)
    return url
  }

  function carregarAvaliacoes(root) {
    var listaEl = root.querySelector('.vz-av-lista')
    var resumoEl = root.querySelector('.vz-av-resumo')

    fetch(montarUrl('/api/avaliacoes'))
      .then(function (r) { return r.json() })
      .then(function (dados) {
        if (dados.total > 0) {
          resumoEl.innerHTML =
            '<span class="vz-av-media">' + dados.media.toFixed(1) + '</span>' +
            '<span class="vz-av-estrelas">' + estrelasTexto(Math.round(dados.media)) + '</span>' +
            '<span class="vz-av-total">' + dados.total + ' avaliaç' + (dados.total === 1 ? 'ão' : 'ões') + '</span>'
        } else {
          resumoEl.innerHTML = '<span class="vz-av-vazio">Seja o primeiro a avaliar</span>'
        }

        if (!dados.avaliacoes.length) {
          listaEl.innerHTML = '<p class="vz-av-vazio">Nenhuma avaliação publicada ainda.</p>'
          return
        }

        listaEl.innerHTML = dados.avaliacoes.map(function (a) {
          return (
            '<div class="vz-av-item">' +
              '<div class="vz-av-item-topo">' +
                '<span class="vz-av-item-nome">' + escapeHtml(a.nome_cliente) + '</span>' +
                '<span class="vz-av-item-data">' + formatarData(a.criado_em) + '</span>' +
              '</div>' +
              '<div class="vz-av-estrelas">' + estrelasTexto(a.nota) + '</div>' +
              '<div class="vz-av-item-comentario">' + escapeHtml(a.comentario) + '</div>' +
            '</div>'
          )
        }).join('')
      })
      .catch(function () {
        listaEl.innerHTML = '<p class="vz-av-vazio">Não foi possível carregar as avaliações agora.</p>'
      })
  }

  function montar() {
    garantirFontes()
    garantirEstilos()

    var root = document.createElement('div')
    root.className = 'vz-avaliacoes-widget'
    root.innerHTML =
      '<h3 class="vz-av-titulo">Avaliações</h3>' +
      '<div class="vz-av-resumo"></div>' +
      '<form class="vz-av-form">' +
        '<label>Seu nome</label>' +
        '<input type="text" name="nome" maxlength="100" required>' +
        '<label>Sua nota</label>' +
        '<div class="vz-av-estrelas-input" data-nota="0">' +
          [1, 2, 3, 4, 5].map(function (n) { return '<button type="button" data-valor="' + n + '">★</button>' }).join('') +
        '</div>' +
        '<label>Seu comentário</label>' +
        '<textarea name="comentario" maxlength="2000" minlength="10" required></textarea>' +
        '<button type="submit" class="vz-av-btn">Enviar avaliação</button>' +
        '<div class="vz-av-msg"></div>' +
      '</form>' +
      '<div class="vz-av-lista"></div>'

    thisScript.parentNode.insertBefore(root, thisScript.nextSibling)

    var estrelasInput = root.querySelector('.vz-av-estrelas-input')
    var botoesEstrela = estrelasInput.querySelectorAll('button')
    botoesEstrela.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var valor = Number(btn.getAttribute('data-valor'))
        estrelasInput.setAttribute('data-nota', String(valor))
        botoesEstrela.forEach(function (b) {
          b.classList.toggle('ativa', Number(b.getAttribute('data-valor')) <= valor)
        })
      })
    })

    var form = root.querySelector('.vz-av-form')
    var msgEl = root.querySelector('.vz-av-msg')
    var btnSubmit = form.querySelector('.vz-av-btn')

    form.addEventListener('submit', function (ev) {
      ev.preventDefault()
      msgEl.textContent = ''
      msgEl.className = 'vz-av-msg'

      var nota = Number(estrelasInput.getAttribute('data-nota'))
      var nome = form.nome.value.trim()
      var comentario = form.comentario.value.trim()

      if (!nota) {
        msgEl.textContent = 'Selecione uma nota de 1 a 5 estrelas.'
        msgEl.className = 'vz-av-msg erro'
        return
      }

      btnSubmit.disabled = true

      fetch(API_BASE + '/api/avaliacoes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome: nome, nota: nota, comentario: comentario, produto_id: produtoId || undefined }),
      })
        .then(function (r) { return r.json().then(function (j) { return { status: r.status, corpo: j } }) })
        .then(function (res) {
          if (res.status === 201) {
            msgEl.textContent = res.corpo.mensagem || 'Avaliação enviada! Entra no ar após moderação.'
            msgEl.className = 'vz-av-msg sucesso'
            form.reset()
            estrelasInput.setAttribute('data-nota', '0')
            botoesEstrela.forEach(function (b) { b.classList.remove('ativa') })
          } else {
            msgEl.textContent = res.corpo.erro || 'Não foi possível enviar sua avaliação.'
            msgEl.className = 'vz-av-msg erro'
          }
        })
        .catch(function () {
          msgEl.textContent = 'Erro de conexão. Tente novamente em instantes.'
          msgEl.className = 'vz-av-msg erro'
        })
        .finally(function () {
          btnSubmit.disabled = false
        })
    })

    carregarAvaliacoes(root)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', montar)
  } else {
    montar()
  }
})()
