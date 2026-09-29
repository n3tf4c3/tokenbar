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

function Get-Countdown {
  param([string] $ResetsAt, [DateTimeOffset] $Now = [DateTimeOffset]::UtcNow)
  $target = ConvertTo-UsageTimestamp $ResetsAt
  if (-not $target) { return '' }
  $span = $target - $Now
  if ($span.TotalSeconds -le 0) { return 'renovando' }
  if ($span.TotalDays -ge 1) { return ('renova em {0}d {1}h' -f $span.Days, $span.Hours) }
  if ($span.TotalHours -ge 1) { return ('renova em {0}h {1}m' -f $span.Hours, $span.Minutes) }
  return ('renova em {0}m' -f [math]::Max(1, [math]::Floor($span.TotalMinutes)))
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
