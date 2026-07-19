// Widget de avaliações do Google — nota geral + 5 mais recentes.
// Uso no tema Nuvemshop:
//   <script src="https://vivenzza-crm-api-production.up.railway.app/widgets/google-reviews.js"></script>
(function () {
  var thisScript = document.currentScript
  var API_BASE = thisScript.getAttribute('data-api-base') || 'https://vivenzza-crm-api-production.up.railway.app'

  function garantirFontes() {
    if (document.querySelector('link[data-vz-fontes]')) return
    var link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'https://fonts.googleapis.com/css2?family=Alumni+Sans:ital,wght@0,100..900;1,100..900&family=Inter+Tight:wght@300;400;500;600&display=swap'
    link.setAttribute('data-vz-fontes', '1')
    document.head.appendChild(link)
  }

  function garantirEstilos() {
    if (document.getElementById('vz-google-reviews-style')) return
    var style = document.createElement('style')
    style.id = 'vz-google-reviews-style'
    style.textContent = [
      '.vz-greviews-widget{--vz-offwhite-1:#FFFAF5;--vz-offwhite-2:#F5EAE1;--vz-offwhite-3:#E6DCD4;--vz-cinza-4:#D9CFC8;--vz-cinza-5:#C9C1B9;--vz-chumbo:#242221;--vz-text-muted:#6B6560;box-sizing:border-box;max-width:900px;margin:0 auto;font-family:"Inter Tight",sans-serif;color:var(--vz-chumbo);}',
      '.vz-greviews-widget *{box-sizing:border-box;}',
      '.vz-gr-destaque{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;background:var(--vz-offwhite-2);border:1px solid var(--vz-cinza-4);border-radius:10px;padding:18px 24px;margin-bottom:24px;text-align:center;}',
      '.vz-gr-estrelas{color:var(--vz-chumbo);font-size:22px;letter-spacing:2px;}',
      '.vz-gr-nota{font-family:"Alumni Sans",sans-serif;font-size:26px;font-weight:800;}',
      '.vz-gr-total{font-size:14px;color:var(--vz-text-muted);}',
      '.vz-gr-carrossel{display:flex;gap:16px;overflow-x:auto;padding-bottom:8px;scroll-snap-type:x mandatory;}',
      '.vz-gr-card{flex:0 0 260px;scroll-snap-align:start;background:var(--vz-offwhite-1);border:1px solid var(--vz-cinza-4);border-radius:10px;padding:16px;}',
      '.vz-gr-card-topo{display:flex;align-items:center;gap:10px;margin-bottom:8px;}',
      '.vz-gr-avatar{width:36px;height:36px;border-radius:50%;object-fit:cover;background:var(--vz-cinza-4);}',
      '.vz-gr-autor{font-weight:600;font-size:13px;}',
      '.vz-gr-tempo{font-size:11px;color:var(--vz-text-muted);}',
      '.vz-gr-card-estrelas{color:var(--vz-chumbo);font-size:14px;letter-spacing:1px;margin-bottom:6px;}',
      '.vz-gr-card-texto{font-size:13px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;}',
      '.vz-gr-link{display:block;text-align:center;margin-top:18px;font-family:"Alumni Sans",sans-serif;font-size:14px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--vz-chumbo);text-decoration:underline;}',
      '.vz-gr-vazio{font-size:13px;color:var(--vz-text-muted);text-align:center;}',
    ].join('')
    document.head.appendChild(style)
  }

  function escapeHtml(str) {
    var div = document.createElement('div')
    div.textContent = str == null ? '' : String(str)
    return div.innerHTML
  }

  function estrelasTexto(nota) {
    var arredondada = Math.round(nota || 0)
    return '★★★★★☆☆☆☆☆'.slice(5 - arredondada, 10 - arredondada)
  }

  function montar() {
    var root = document.createElement('div')
    root.className = 'vz-greviews-widget'
    root.innerHTML = '<div class="vz-gr-vazio">Carregando avaliações do Google…</div>'
    thisScript.parentNode.insertBefore(root, thisScript.nextSibling)

    fetch(API_BASE + '/api/google-reviews')
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, corpo: j } }) })
      .then(function (res) {
        if (res.status !== 200) {
          root.innerHTML = '<div class="vz-gr-vazio">Avaliações do Google indisponíveis no momento.</div>'
          return
        }

        garantirFontes()
        garantirEstilos()

        var dados = res.corpo
        var totalTexto = dados.user_ratings_total ? dados.user_ratings_total + '+ avaliações no Google' : 'avaliações no Google'

        var html =
          '<div class="vz-gr-destaque">' +
            '<span class="vz-gr-estrelas">' + estrelasTexto(dados.rating) + '</span>' +
            '<span class="vz-gr-nota">' + (dados.rating != null ? dados.rating.toFixed(1) : '-') + '</span>' +
            '<span class="vz-gr-total">· ' + totalTexto + '</span>' +
          '</div>'

        if (dados.reviews && dados.reviews.length) {
          html += '<div class="vz-gr-carrossel">' + dados.reviews.map(function (r) {
            var avatar = r.foto_perfil ? escapeHtml(r.foto_perfil) : ''
            return (
              '<div class="vz-gr-card">' +
                '<div class="vz-gr-card-topo">' +
                  (avatar ? '<img class="vz-gr-avatar" src="' + avatar + '" alt="" loading="lazy">' : '<div class="vz-gr-avatar"></div>') +
                  '<div>' +
                    '<div class="vz-gr-autor">' + escapeHtml(r.autor) + '</div>' +
                    '<div class="vz-gr-tempo">' + escapeHtml(r.tempo_relativo) + '</div>' +
                  '</div>' +
                '</div>' +
                '<div class="vz-gr-card-estrelas">' + estrelasTexto(r.nota) + '</div>' +
                '<div class="vz-gr-card-texto">' + escapeHtml(r.texto) + '</div>' +
              '</div>'
            )
          }).join('') + '</div>'
        }

        html += '<a class="vz-gr-link" href="' + escapeHtml(dados.mapsUrl) + '" target="_blank" rel="noopener">Ver todas as avaliações no Google</a>'

        root.innerHTML = html
      })
      .catch(function () {
        root.innerHTML = '<div class="vz-gr-vazio">Não foi possível carregar as avaliações agora.</div>'
      })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', montar)
  } else {
    montar()
  }
})()
