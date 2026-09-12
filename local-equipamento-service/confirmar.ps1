# Confirmação visível ao usuário antes de assinar (protocolo, camada 5 de
# defesa — detecção humana, não técnica; última linha, não a principal).
# Caixa de diálogo nativa do Windows (Yes/No), sempre em primeiro plano.
param(
  [Parameter(Mandatory = $true)][string]$Mensagem
)
Add-Type -AssemblyName System.Windows.Forms
$resultado = [System.Windows.Forms.MessageBox]::Show(
  $Mensagem,
  'Meu Ponto — confirmar assinatura do equipamento',
  [System.Windows.Forms.MessageBoxButtons]::YesNo,
  [System.Windows.Forms.MessageBoxIcon]::Question,
  [System.Windows.Forms.MessageBoxDefaultButton]::Button2,
  [System.Windows.Forms.MessageBoxOptions]::DefaultDesktopOnly
)
if ($resultado -eq [System.Windows.Forms.DialogResult]::Yes) {
  Write-Output 'sim'
} else {
  Write-Output 'nao'
}
