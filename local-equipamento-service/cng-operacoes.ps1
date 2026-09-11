# Operações CNG do serviço local de equipamento — Windows CNG via .NET
# Framework (System.Security.Cryptography), chamado como processo filho
# pelo serviço Node (servico.mjs). NENHUMA criptografia própria: só
# NCryptCreatePersistedKey (via CngKey.Create), ECDsaCng.SignData
# (ECDSA P-256 / SHA-256), export de chave pública via CngKey.Export.
#
# Formatos (validados de ponta a ponta contra node:crypto — ver
# docs/meu-ponto/PROTOCOLO_COMPONENTE_WINDOWS.md §0):
# - Assinatura: raw IEEE P1363 (64 bytes, r‖s) — formato nativo do
#   ECDsaCng.SignData em .NET Framework.
# - Chave pública exportada: BCRYPT_ECCKEY_BLOB (72 bytes: magic(4) +
#   cbKey(4) + X(32) + Y(32)) — convertido aqui mesmo pra JWK antes de
#   devolver ao chamador (parsing estrutural de um formato documentado da
#   Microsoft, não uma operação criptográfica).
#
# Política de exportação SEMPRE None (CngExportPolicies.None) — a chave
# privada nunca sai do CNG, nem em memória do processo Node, nem em disco,
# nem em nenhum JSON. Só a chave PÚBLICA (e uma assinatura) cruzam essa
# fronteira.
#
# Uso: powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass
#   -File cng-operacoes.ps1 -Acao <criar-chave|assinar|remover-chave> ...
# Sempre chamado com argumentos posicionais/nomeados via array (nunca
# concatenação de string em -Command) — evita qualquer risco de injeção.

param(
  [Parameter(Mandatory = $true)][ValidateSet('criar-chave', 'assinar', 'remover-chave')][string]$Acao,
  [Parameter(Mandatory = $true)][string]$NomeChave,
  [string]$HardwareBacked, # 'true'/'false' — só usado em -Acao assinar/remover-chave, pra saber qual provider reabrir
  [string]$DadosBase64     # só usado em -Acao assinar — bytes (já concatenados/canônicos) a assinar, em base64
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

function Escrever-Json($objeto) {
  # Profundidade 5 é suficiente pro shape usado aqui; ConvertTo-Json corta
  # silenciosamente além da profundidade padrão (2) se não especificado.
  Write-Output ($objeto | ConvertTo-Json -Depth 5 -Compress)
}

function Obter-Provider([bool]$hardwareBacked) {
  if ($hardwareBacked) {
    return New-Object System.Security.Cryptography.CngProvider('Microsoft Platform Crypto Provider')
  }
  return New-Object System.Security.Cryptography.CngProvider('Microsoft Software Key Storage Provider')
}

function Blob-Para-Jwk([byte[]]$blob) {
  # BCRYPT_ECCKEY_BLOB: primeiros 4 bytes = magic (ignorado aqui, backend
  # não precisa dele — só cbKey importa pra saber onde X termina e Y começa),
  # próximos 4 bytes = cbKey (tamanho de cada coordenada, 32 para P-256).
  $cbKey = [BitConverter]::ToUInt32($blob, 4)
  $x = $blob[8..(8 + $cbKey - 1)]
  $y = $blob[(8 + $cbKey)..(8 + 2 * $cbKey - 1)]
  return [PSCustomObject]@{
    kty = 'EC'
    crv = 'P-256'
    x   = [Convert]::ToBase64String($x).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    y   = [Convert]::ToBase64String($y).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  }
}

try {
  switch ($Acao) {
    'criar-chave' {
      # Tenta TPM primeiro; se falhar (sem TPM utilizável nesta máquina),
      # cai pro KSP de software — o cadastro NUNCA fica bloqueado por
      # ausência de TPM (decisão de negócio documentada na proposta, não
      # uma escolha técnica silenciosa: chave_hardware_backed é sempre
      # reportado de volta pro backend, que grava e expõe no painel).
      $hardwareBacked = $true
      $provider = Obter-Provider $true
      $keyParams = New-Object System.Security.Cryptography.CngKeyCreationParameters
      $keyParams.Provider = $provider
      $keyParams.ExportPolicy = [System.Security.Cryptography.CngExportPolicies]::None
      $keyParams.KeyUsage = [System.Security.Cryptography.CngKeyUsages]::Signing
      try {
        $key = [System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::ECDsaP256, $NomeChave, $keyParams)
      } catch {
        $hardwareBacked = $false
        $provider = Obter-Provider $false
        $keyParams.Provider = $provider
        $key = [System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::ECDsaP256, $NomeChave, $keyParams)
      }
      $pubBlob = $key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
      $jwk = Blob-Para-Jwk $pubBlob
      $key.Dispose()
      Escrever-Json ([PSCustomObject]@{ ok = $true; hardwareBacked = $hardwareBacked; chavePublicaJwk = $jwk })
    }

    'assinar' {
      if (-not $DadosBase64) { throw 'DadosBase64 é obrigatório para -Acao assinar' }
      $hb = $HardwareBacked -eq 'true'
      $provider = Obter-Provider $hb
      $key = [System.Security.Cryptography.CngKey]::Open($NomeChave, $provider)
      $ecdsa = New-Object System.Security.Cryptography.ECDsaCng($key)
      $dados = [Convert]::FromBase64String($DadosBase64)
      $sig = $ecdsa.SignData($dados, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
      $key.Dispose()
      Escrever-Json ([PSCustomObject]@{ ok = $true; assinaturaBase64 = [Convert]::ToBase64String($sig) })
    }

    'remover-chave' {
      $hb = $HardwareBacked -eq 'true'
      $provider = Obter-Provider $hb
      $key = [System.Security.Cryptography.CngKey]::Open($NomeChave, $provider)
      $key.Delete()
      Escrever-Json ([PSCustomObject]@{ ok = $true })
    }
  }
} catch {
  Escrever-Json ([PSCustomObject]@{ ok = $false; erro = $_.Exception.Message })
  exit 1
}
