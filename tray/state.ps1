# Funcoes de estado sem GUI, compartilhadas pela bandeja e pelos testes Windows.

$script:DisabledProviders = @()
$script:DaemonFailures = 0
$script:DaemonLastAttempt = [datetime]::MinValue
$script:DaemonRetrySeconds = 60
$script:DaemonMaxFailures = 5
$script:DaemonMinUptimeSeconds = 120

# Um daemon que morre (ou não sobe) não pode ser relançado a cada tick de 3 s: cada
# tentativa cria processos, e isso é o que antivírus comportamentais enxergam como loop.
function Test-DaemonStartAllowed {
  param([datetime] $Now = [datetime]::UtcNow)
  if ($script:DaemonFailures -ge $script:DaemonMaxFailures) { return $false }
  return (($Now - $script:DaemonLastAttempt).TotalSeconds -ge $script:DaemonRetrySeconds)
}

function Register-DaemonAttempt {
  param([datetime] $Now = [datetime]::UtcNow)
  $script:DaemonLastAttempt = $Now
}

# Vida curta conta como falha; um daemon que durou o bastante zera a contagem.
function Register-DaemonExit {
  param([timespan] $Uptime)
  if ($Uptime.TotalSeconds -lt $script:DaemonMinUptimeSeconds) { $script:DaemonFailures++ } else { $script:DaemonFailures = 0 }
}

function Register-DaemonLaunchFailure {
  $script:DaemonFailures++
}

function Reset-DaemonBackoff {
  $script:DaemonFailures = 0
  $script:DaemonLastAttempt = [datetime]::MinValue
}

# A bandeja roda oculta: sem este log, uma morte inesperada não deixa rastro. Nunca lança.
function Write-TrayLog {
  param([string] $Path, [string] $Message)
  if (-not $Path) { return }
  try {
    if ((Test-Path $Path) -and (Get-Item $Path).Length -gt 200KB) {
      Move-Item $Path ([System.IO.Path]::ChangeExtension($Path, 'previous.log')) -Force
    }
    Add-Content -Path $Path -Encoding UTF8 -Value ('{0} [{1}] {2}' -f [datetime]::UtcNow.ToString('o'), $PID, $Message)
  } catch {
    # Falha ao registrar não deve interromper o funcionamento
  }
}

# Host do atalho de inicializacao. No PowerShell 7, $PSHOME tem pwsh.exe e nao powershell.exe;
# o Windows PowerShell do sistema e o contrato documentado, com o pwsh.exe atual como alternativa.
function Resolve-StartupHost {
  param([string] $SystemRoot = $env:SystemRoot, [string] $HostHome = $PSHOME)
  $candidates = @()
  if ($SystemRoot) { $candidates += Join-Path $SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
  if ($HostHome) { $candidates += (Join-Path $HostHome 'powershell.exe'), (Join-Path $HostHome 'pwsh.exe') }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  return $null
}

# Argumentos do conhost: --headless evita a janela do Windows Terminal (fecha-la mataria a bandeja);
# RemoteSigned dispensa Bypass para scripts locais.
function Get-StartupArguments {
  param([string] $HostExe, [string] $ScriptPath)
  return ('--headless "{0}" -NoProfile -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "{1}"' -f $HostExe, $ScriptPath)
}

# Comando de inicializacao atual: conhost --headless com um host PowerShell que existe e,
# quando informado, o mesmo tokenbar.ps1 (a pasta do projeto pode ter mudado de lugar).
function Test-StartupCommandCurrent {
  param([string] $Execute, [string] $Arguments, [string] $ScriptPath)
  if ($Execute -notmatch '\\conhost\.exe$' -or -not (Test-Path -LiteralPath $Execute -PathType Leaf)) { return $false }
  if ($Arguments -notmatch '^--headless\s+"([^"]+)"') { return $false }
  if (-not (Test-Path -LiteralPath $Matches[1] -PathType Leaf)) { return $false }
  if ($ScriptPath -and -not $Arguments.EndsWith(('-File "{0}"' -f $ScriptPath), [StringComparison]::OrdinalIgnoreCase)) { return $false }
  return $true
}

function Get-DisabledProviders {
  return @($script:DisabledProviders)
}

function Set-DisabledProviders {
  param([string[]] $Providers)
  if ($null -eq $Providers) {
    $script:DisabledProviders = @()
  } else {
    $script:DisabledProviders = @($Providers | Where-Object { $_ -and $_.Trim() -ne '' })
  }
}

function Read-TrayConfig {
  param([string] $Path)
  if (-not $Path -or -not (Test-Path $Path)) {
    $script:DisabledProviders = @()
    return
  }
  try {
    $json = Get-Content -Raw -Path $Path -Encoding UTF8 | ConvertFrom-Json
    if ($json.disabledProviders) {
      $script:DisabledProviders = @($json.disabledProviders)
    } else {
      $script:DisabledProviders = @()
    }
  } catch {
    $script:DisabledProviders = @()
  }
}

function Save-TrayConfig {
  param([string] $Path)
  if (-not $Path) { return }
  try {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) {
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    @{ disabledProviders = @($script:DisabledProviders) } | ConvertTo-Json | Set-Content -Path $Path -Encoding UTF8
  } catch {
    # Falha ao salvar nao deve interromper o funcionamento
  }
}

function ConvertTo-UsageTimestamp {
  param([string] $Value)
  $parsed = [DateTimeOffset]::MinValue
  if ($Value -and [DateTimeOffset]::TryParse($Value, [ref] $parsed)) { return $parsed }
  return $null
}

function Get-WindowShortLabel {
  param($Window)
  if ($Window.shortLabel) { return [string] $Window.shortLabel }
  if ($Window.durationMinutes) {
    $minutes = [int] $Window.durationMinutes
    if ($minutes -eq 300) { return '5h' }
    if ($minutes -eq 10080) { return 'sem' }
    if ($minutes % 1440 -eq 0) { return "$($minutes / 1440)d" }
    if ($minutes % 60 -eq 0) { return "$($minutes / 60)h" }
    return "${minutes}m"
  }
  if ($Window.id -eq 'five_hour') { return '5h' }
  if ($Window.id -eq 'seven_day') { return 'sem' }
  if ($Window.id -like 'weekly_*') {
    $model = $Window.label -replace ('^.*' + [char] 0x00B7 + '\s*'), ''
    if ($model -and $model -ne $Window.label) { return "sem $model" }
    return 'sem'
  }
  return '-'
}

# -Short e a forma do painel ("1d 18h"); sem ele, a forma por extenso do texto acessivel.
function Get-Countdown {
  param([string] $ResetsAt, [DateTimeOffset] $Now = [DateTimeOffset]::UtcNow, [switch] $Short)
  $target = ConvertTo-UsageTimestamp $ResetsAt
  if (-not $target) { return '' }
  $span = $target - $Now
  if ($span.TotalSeconds -le 0) { if ($Short) { return 'renov.' } else { return 'renovando' } }
  $prefix = if ($Short) { '' } else { 'renova em ' }
  if ($span.TotalDays -ge 1) { return ('{0}{1}d {2}h' -f $prefix, $span.Days, $span.Hours) }
  if ($span.TotalHours -ge 1) { return ('{0}{1}h {2}m' -f $prefix, $span.Hours, $span.Minutes) }
  return ('{0}{1}m' -f $prefix, [math]::Max(1, [math]::Floor($span.TotalMinutes)))
}

# Estimativa de valor equivalente em API publicada pelo daemon (snapshot.costs). Nao e cobranca.
function Get-ProviderCost {
  param($Provider)
  if (-not $Provider -or -not $script:Snapshot -or -not $script:Snapshot.costs) { return $null }
  foreach ($cost in @($script:Snapshot.costs)) {
    if ([string] $cost.provider -eq [string] $Provider.provider -and $cost.todayUsd -is [ValueType] -and $cost.weekUsd -is [ValueType]) { return $cost }
  }
  return $null
}

function Format-UsdShort {
  param([double] $Amount)
  $culture = [System.Globalization.CultureInfo]::GetCultureInfo('pt-BR')
  if ($Amount -ge 1000) { return '$' + ($Amount / 1000).ToString('0.0', $culture) + 'k' }
  if ($Amount -ge 10 -or $Amount -eq 0) { return '$' + [math]::Round($Amount).ToString('0', $culture) }
  return '$' + $Amount.ToString('0.0', $culture)
}

# Forma curta do painel: "~$6,9 hj . $948 7d"; "+" marca piso (modelo sem preco conhecido).
function Get-CostText {
  param($Provider)
  $cost = Get-ProviderCost $Provider
  if (-not $cost) { return '' }
  $plus = if ($cost.partial) { '+' } else { '' }
  return ('{0}{1} hj {2} {3}{4} 7d' -f [char] 0x2248, (Format-UsdShort ([double] $cost.todayUsd)), [char] 0x00B7, (Format-UsdShort ([double] $cost.weekUsd)), $plus)
}

function Get-CostAccessibleText {
  param($Provider)
  $cost = Get-ProviderCost $Provider
  if (-not $cost) { return '' }
  $culture = [System.Globalization.CultureInfo]::GetCultureInfo('pt-BR')
  $text = 'custo estimado em API: US$ {0} hoje, US$ {1} em 7 dias' -f ([double] $cost.todayUsd).ToString('0.00', $culture), ([double] $cost.weekUsd).ToString('0.00', $culture)
  if ($cost.partial) { $text += ', sem contar modelos sem preco conhecido' }
  return $text
}

function Get-VisibleProviders {
  if ($script:Snapshot) {
    return @($script:Snapshot.providers | Where-Object {
      -not ($script:DisabledProviders -contains [string] $_.provider)
    })
  }
}

function Test-WindowExpired {
  param($Window, [DateTimeOffset] $Now = [DateTimeOffset]::UtcNow)
  if (-not $Window.resetsAt) { return $false }
  $reset = ConvertTo-UsageTimestamp $Window.resetsAt
  return (-not $reset -or $reset -le $Now)
}

function Test-ProviderOutdated {
  param($Provider, [DateTimeOffset] $Now = [DateTimeOffset]::UtcNow)
  $collected = ConvertTo-UsageTimestamp $Provider.collectedAt
  return ($Provider.status -ne 'ok' -or -not $collected -or ($Now - $collected).TotalMinutes -ge 10)
}

# Motivo curto da ultima falha, para o cabecalho do provedor e o texto acessivel.
# Vem so de failureKind/failureCode (valores fixos do daemon), nunca de texto remoto.
function Get-FailureLabel {
  param($Provider)
  if (-not $Provider -or $Provider.status -eq 'ok') { return '' }
  if ([string] $Provider.failureCode -match '^HTTP_([0-9]{3})$') { return 'HTTP ' + $Matches[1] }
  if ([string] $Provider.failureCode -ceq 'TOKEN_REVOKED') { return 'login revogado' }
  if ([string] $Provider.failureCode -ceq 'LOGGED_OUT') { return 'login encerrado' }
  switch ([string] $Provider.failureKind) {
    'auth' { return 'login' }
    'rate-limit' { return 'limite de consultas' }
    'tls' { return 'certificado' }
    'network' { return 'rede' }
    'timeout' { return 'sem resposta' }
    'invalid-response' { return 'resposta inesperada' }
  }
  return ''
}

function Test-ProviderAttention {
  param($Provider, [DateTimeOffset] $Now = [DateTimeOffset]::UtcNow)
  if ((Test-ProviderOutdated $Provider $Now) -or -not $Provider.windows) { return $true }
  foreach ($window in @($Provider.windows)) { if (Test-WindowExpired $window $Now) { return $true } }
  return $false
}

function Get-WorstUsage {
  param([DateTimeOffset] $Now = [DateTimeOffset]::UtcNow)
  $worst = $null
  foreach ($provider in @(Get-VisibleProviders)) {
    if (Test-ProviderOutdated $provider $Now) { continue }
    foreach ($window in @($provider.windows)) {
      if (Test-WindowExpired $window $Now) { continue }
      if (-not $worst -or $window.usedPercent -gt $worst.usedPercent) { $worst = $window }
    }
  }
  return $worst
}

# O painel e desenhado com GDI+, sem controles que um leitor de tela enxergue. Este texto
# repete o conteudo de cada linha (janela, percentual usado e renovacao) e vira o nome
# acessivel do painel a cada atualizacao (Update-PanelAccessibility, em tokenbar.ps1).
function Get-PanelAccessibleText {
  param([DateTimeOffset] $Now = [DateTimeOffset]::UtcNow)
  $providers = @(Get-VisibleProviders)
  if (-not $providers.Count) {
    if ($script:Snapshot -and $script:Snapshot.providers -and @($script:Snapshot.providers).Count -gt 0) {
      return 'Nenhum provedor selecionado.'
    }
    return 'Sem dados.'
  }
  $parts = foreach ($provider in $providers) {
    $name = [string] $provider.label
    $tags = @()
    if ($provider.plan) { $tags += 'plano ' + $provider.plan }
    if ($provider.stale -or (Test-ProviderOutdated $provider $Now)) { $tags += 'dados em cache' }
    $failure = Get-FailureLabel $provider
    if ($failure) { $tags += 'falha: ' + $failure }
    $costText = Get-CostAccessibleText $provider
    if ($costText) { $tags += $costText }
    if ($tags.Count) { $name += ' (' + ($tags -join ', ') + ')' }
    if (-not $provider.windows) {
      '{0}: sem dados.' -f $name
    } else {
      $rows = foreach ($window in @($provider.windows)) {
        $label = if ($window.label) { [string] $window.label } else { Get-WindowShortLabel $window }
        $row = '{0}, {1:0}% usado' -f $label, [double] $window.usedPercent
        $countdown = Get-Countdown ([string] $window.resetsAt) $Now
        if ($countdown) { $row += ', ' + $countdown }
        $row
      }
      '{0}: {1}.' -f $name, ($rows -join '; ')
    }
  }
  return ($parts -join ' ')
}

function Get-TooltipText {
  param([DateTimeOffset] $Now = [DateTimeOffset]::UtcNow)
  $providers = @(Get-VisibleProviders)
  if (-not $providers.Count) {
    if ($script:Snapshot -and $script:Snapshot.providers -and @($script:Snapshot.providers).Count -gt 0) {
      return 'TokenBar - nenhum provedor selecionado'
    }
    return 'TokenBar - sem dados'
  }
  $parts = foreach ($provider in $providers) {
    if (Test-ProviderAttention $provider $Now) {
      '{0}: indisponivel' -f $provider.label
    } else {
      $values = foreach ($window in @($provider.windows)) {
        '{0} {1:0}%' -f (Get-WindowShortLabel $window), [double] $window.usedPercent
      }
      '{0}: {1}' -f $provider.label, ($values -join ' ')
    }
  }
  $text = $parts -join ' | '
  if ($text.Length -gt 63) {
    # O tooltip do Windows aceita 63 caracteres; preserve todos os provedores.
    $parts = foreach ($provider in $providers) {
      if (Test-ProviderAttention $provider $Now) {
        '{0}: ?' -f $provider.label
      } else {
        $maximum = ($provider.windows | Measure-Object -Property usedPercent -Maximum).Maximum
        '{0}: {1:0}%' -f $provider.label, $maximum
      }
    }
    $text = $parts -join ' | '
  }
  if ($text.Length -gt 63) { return $text.Substring(0, 60) + '...' }
  return $text
}
