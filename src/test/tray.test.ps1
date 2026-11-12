$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\tray\state.ps1')
$now = [DateTimeOffset]'2026-09-05T13:00:00Z'
$passed = 0
# Toda escrita dos testes fica nesta pasta exclusiva, removida no final.
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$fixture = Join-Path $tempRoot ('tokenbar-tray-test-{0}' -f [guid]::NewGuid())
New-Item -ItemType Directory -Path $fixture | Out-Null
function Remove-TestFixture {
  # Só apaga a pasta criada acima: filha direta do TEMP e com o prefixo do teste.
  $parent = [System.IO.Path]::GetFullPath((Split-Path -Parent $fixture)).TrimEnd('\')
  if ($parent -eq $tempRoot.TrimEnd('\') -and (Split-Path -Leaf $fixture) -like 'tokenbar-tray-test-*' -and (Test-Path -LiteralPath $fixture)) {
    Remove-Item -LiteralPath $fixture -Recurse -Force
  }
}
trap { Remove-TestFixture; break }
function Assert-Equal {
  param($Actual, $Expected, [string] $Message)
  if ($Actual -ne $Expected) { throw "$Message - expected: $Expected; actual: $Actual" }
  $script:passed++
  Write-Output "PASS: $Message"
}
Assert-Equal (Get-Countdown '2026-09-05T14:45:00Z' $now) 'renova em 1h 45m' 'Hours are truncated, not rounded'
Assert-Equal (Get-Countdown '2026-09-07T07:00:00Z' $now) 'renova em 1d 18h' 'Days are truncated, not rounded'
Assert-Equal (Get-Countdown '2026-09-05T13:00:20Z' $now) 'renova em 1m' 'Less than a minute never shows zero'
Assert-Equal (Get-Countdown '2026-09-05T12:00:00Z' $now) 'renovando' 'Expired window keeps the compact countdown'
Assert-Equal (Get-Countdown 'invalid' $now) '' 'Invalid dates are handled'
Assert-Equal (Get-Countdown '2026-09-07T07:00:00Z' $now -Short) '1d 18h' 'Panel countdown drops the prefix'
Assert-Equal (Get-Countdown '2026-09-05T13:00:20Z' $now -Short) '1m' 'Short countdown never shows zero'
Assert-Equal (Get-Countdown '2026-09-05T12:00:00Z' $now -Short) 'renov.' 'Short countdown abbreviates an expired window'

$dot = [char] 0x00B7; $approx = [char] 0x2248
$script:Snapshot = [pscustomobject]@{providers=@(); costs=@(
  [pscustomobject]@{provider='claude';todayUsd=6.86;weekUsd=947.94;computedAt=$now.ToString('o')},
  [pscustomobject]@{provider='codex';todayUsd=0;weekUsd=1056.53;partial=$true;computedAt=$now.ToString('o')})}
Assert-Equal (Get-CostText ([pscustomobject]@{provider='claude'})) "$approx`$6,9 hj $dot `$948 7d" 'Cost line is short, in pt-BR decimals'
Assert-Equal (Get-CostText ([pscustomobject]@{provider='codex'})) "$approx`$0 hj $dot `$1,1k+ 7d" 'Unpriced models mark the week total as a floor'
Assert-Equal (Get-CostText ([pscustomobject]@{provider='antigravity'})) '' 'Providers without an estimate show no cost'
Assert-Equal (Get-CostAccessibleText ([pscustomobject]@{provider='claude'})) 'custo estimado em API: US$ 6,86 hoje, US$ 947,94 em 7 dias' 'Accessible cost keeps full values'
$script:Snapshot.costs = @([pscustomobject]@{provider='claude';todayUsd='6';weekUsd=1})
Assert-Equal (Get-CostText ([pscustomobject]@{provider='claude'})) '' 'A malformed estimate is ignored'
$script:Snapshot = $null

$claude = [pscustomobject]@{provider='claude';label='Claude';status='unavailable';stale=$true;failureKind='auth';message='Session expired. Use /login.';collectedAt=$now.AddMinutes(-6).ToString('o');windows=@([pscustomobject]@{id='five_hour';usedPercent=93;resetsAt=$now.AddHours(-1).ToString('o')})}
$codex = [pscustomobject]@{provider='codex';label='Codex';status='ok';collectedAt=$now.ToString('o');windows=@([pscustomobject]@{id='seven_day';usedPercent=31;resetsAt=$now.AddHours(5).ToString('o')})}
$script:Snapshot = [pscustomobject]@{providers=@($claude,$codex)}
Assert-Equal (Get-WorstUsage $now).usedPercent 31 'Expired Claude cache does not control tray percentage'
Assert-Equal ((Get-TooltipText $now) -match 'Claude: indisponivel') $true 'Tooltip keeps failures compact'
$claude.status = 'ok'; $claude.failureKind = $null
Assert-Equal (Test-ProviderAttention $claude $now) $true 'Expired reset needs attention even with recent cache'
Assert-Equal (Test-ProviderOutdated $codex $now.AddMinutes(10)) $true 'A stopped daemon becomes visibly outdated'
$script:Snapshot = [pscustomobject]@{providers=@($codex)}
Assert-Equal ((Get-TooltipText $now) -match 'Codex') $true 'One provider renders correctly on PowerShell 5.1'
$antigravity = [pscustomobject]@{provider='antigravity';label='Antigravity';status='ok';collectedAt=$now.ToString('o');windows=@(
  [pscustomobject]@{id='antigravity_gemini_five_hour';shortLabel='Gem 5h';durationMinutes=300;usedPercent=80;resetsAt=$now.AddHours(5).ToString('o')},
  [pscustomobject]@{id='antigravity_claude_gpt_seven_day';shortLabel='C/G sem';durationMinutes=10080;usedPercent=0;resetsAt=$now.AddDays(7).ToString('o')}
)}
Assert-Equal (Get-WindowShortLabel $antigravity.windows[0]) 'Gem 5h' 'Antigravity distinguishes Gemini in compact rows'
Assert-Equal (Get-WindowShortLabel $antigravity.windows[1]) 'C/G sem' 'Antigravity distinguishes its Claude and GPT quota'
$script:Snapshot = [pscustomobject]@{providers=@($codex,$antigravity)}
Assert-Equal (Get-WorstUsage $now).usedPercent 80 'Antigravity participates in the tray percentage'
$script:Snapshot = [pscustomobject]@{providers=@($claude,$codex,$antigravity)}
Assert-Equal (Get-TooltipText $now) 'Claude: ? | Codex: 31% | Antigravity: 80%' 'Long tooltips retain all three providers and their highest valid usage'
$codex.status = 'unavailable'; $antigravity.status = 'unavailable'
Assert-Equal (Get-TooltipText $now) 'Claude: ? | Codex: ? | Antigravity: ?' 'Unavailable providers also fit within the Windows tooltip limit'
$codex.status = 'ok'
$codex.windows += @(
  [pscustomobject]@{id='codex_bengalfox_primary';shortLabel='Spark 5h';durationMinutes=300;usedPercent=40;resetsAt=$now.AddHours(5).ToString('o')},
  [pscustomobject]@{id='codex_bengalfox_secondary';shortLabel='Spark 7d';durationMinutes=10080;usedPercent=92;resetsAt=$now.AddDays(7).ToString('o')}
)
Assert-Equal (Get-WindowShortLabel $codex.windows[1]) 'Spark 5h' 'Spark five-hour quota has a compact distinct label'
Assert-Equal (Get-WindowShortLabel $codex.windows[2]) 'Spark 7d' 'Spark weekly quota has a compact distinct label'
Assert-Equal (Get-WorstUsage $now).usedPercent 92 'Spark can determine the tray percentage without being added to the Codex quota'
$codex.windows[2].resetsAt = $now.AddMinutes(-1).ToString('o')
Assert-Equal (Get-WorstUsage $now).usedPercent 40 'Expired Spark quota no longer controls the tray percentage'

# Testes de filtragem de provedores
$antigravity.status = 'ok'
$script:Snapshot = [pscustomobject]@{providers=@($claude,$codex,$antigravity)}

Set-DisabledProviders @('antigravity')
$visible = @(Get-VisibleProviders)
Assert-Equal $visible.Count 2 'Disabled provider is excluded from visible providers'
Assert-Equal ($visible | Where-Object { $_.provider -eq 'antigravity' }) $null 'Antigravity is not in visible providers'
Assert-Equal (Get-WorstUsage $now).usedPercent 40 'Worst usage ignores disabled provider'
Assert-Equal ((Get-TooltipText $now) -match 'Antigravity') $false 'Tooltip does not include disabled provider'

Set-DisabledProviders @('claude', 'codex', 'antigravity')
Assert-Equal @(Get-VisibleProviders).Count 0 'All providers can be disabled'
Assert-Equal (Get-WorstUsage $now) $null 'Worst usage is null when all providers are disabled'
Assert-Equal (Get-TooltipText $now) 'TokenBar - nenhum provedor selecionado' 'Tooltip informs when all providers are deselected'

# Teste de persistencia e leitura da configuracao
$tempConfig = Join-Path $fixture 'tray-config.json'
try {
  Set-DisabledProviders @('claude', 'antigravity')
  Save-TrayConfig $tempConfig
  Set-DisabledProviders @()
  Assert-Equal (Get-DisabledProviders).Count 0 'Disabled providers reset to empty'
  Read-TrayConfig $tempConfig
  $loaded = Get-DisabledProviders
  Assert-Equal $loaded.Count 2 'Config restores saved disabled providers'
  Assert-Equal ($loaded -contains 'claude') $true 'Config restores claude'
  Assert-Equal ($loaded -contains 'antigravity') $true 'Config restores antigravity'
} finally {
  if (Test-Path $tempConfig) { Remove-Item $tempConfig -Force }
}

Set-DisabledProviders @()

# Backoff de relancamento do daemon
Assert-Equal (Test-DaemonStartAllowed $now.UtcDateTime) $true 'First daemon start is allowed immediately'
Register-DaemonAttempt $now.UtcDateTime
Assert-Equal (Test-DaemonStartAllowed $now.UtcDateTime.AddSeconds(3)) $false 'Daemon is not relaunched on the next 3 s tick'
Assert-Equal (Test-DaemonStartAllowed $now.UtcDateTime.AddSeconds(60)) $true 'Daemon may be retried after a minute'
1..4 | ForEach-Object { Register-DaemonExit ([timespan]::FromSeconds(2)) }
Assert-Equal (Test-DaemonStartAllowed $now.UtcDateTime.AddHours(1)) $true 'Four short-lived daemons still allow a retry'
Register-DaemonLaunchFailure
Assert-Equal (Test-DaemonStartAllowed $now.UtcDateTime.AddHours(1)) $false 'Five consecutive failures stop the relaunch loop'
Reset-DaemonBackoff
Assert-Equal (Test-DaemonStartAllowed $now.UtcDateTime) $true 'Refresh now restarts the daemon after giving up'
Register-DaemonExit ([timespan]::FromSeconds(2))
Register-DaemonExit ([timespan]::FromMinutes(30))
Assert-Equal $script:DaemonFailures 0 'A daemon that ran long enough clears the failure count'
Reset-DaemonBackoff

# Atalho de inicializacao (achado 5): a funcao real do tokenbar.ps1, so com pastas da fixture.
$trayAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\..\tray\tokenbar.ps1'), [ref] $null, [ref] $null)
function Get-TrayFunction {
  param([string] $Name)
  $node = $trayAst.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Name }, $true)
  if (-not $node) { throw "tokenbar.ps1 nao define $Name" }
  return $node
}
foreach ($name in 'Get-StartupTask', 'Save-StartupTask', 'Remove-StartupTask', 'Sync-StartupRegistration') {
  . ([scriptblock]::Create((Get-TrayFunction $name).Extent.Text))
}
# Agendador falso. O módulo ScheduledTasks é importado antes: se ele carregasse sozinho na primeira
# chamada de New-ScheduledTaskAction, as funções dele passariam por cima destas e o teste
# registraria uma tarefa real. New-ScheduledTask* só montam objetos em memória e ficam reais.
Import-Module ScheduledTasks
$script:FakeTask = $null
$script:RegisterCalls = 0
$script:RegisterFails = $false
function Register-ScheduledTask {
  [CmdletBinding()]
  param($TaskPath, $TaskName, $Description, $Action, $Trigger, $Principal, $Settings, [switch] $Force)
  $script:RegisterCalls++
  if ($script:RegisterFails) { throw 'Acesso negado (simulado)' }
  $script:FakeTask = [pscustomobject]@{TaskPath=$TaskPath;TaskName=$TaskName;Actions=@($Action);Triggers=@($Trigger);Principal=$Principal;Settings=$Settings}
  return $script:FakeTask
}
function Get-ScheduledTask {
  [CmdletBinding()]
  param($TaskPath, $TaskName)
  if (-not $script:FakeTask -or $script:FakeTask.TaskName -ne $TaskName) { throw 'Tarefa inexistente (simulado)' }
  return $script:FakeTask
}
function Unregister-ScheduledTask {
  [CmdletBinding()]
  param($TaskPath, $TaskName, [switch] $Confirm)
  $script:FakeTask = $null
}
foreach ($name in 'Register-ScheduledTask', 'Get-ScheduledTask', 'Unregister-ScheduledTask') {
  $resolved = Get-Command $name
  if ($resolved.Module) { throw "$name resolve para o modulo $($resolved.ModuleName), nao para o agendador falso" }
}
# Nome exclusivo: mesmo que o agendador falso falhe, a tarefa real do usuário não é tocada.
$script:StartupTaskName = 'TokenBar-teste-{0}' -f [guid]::NewGuid().ToString('N')
$script:TrayScript = Join-Path $fixture 'tray\tokenbar.ps1'
$fakeRoot = Join-Path $fixture 'Windows'
$bareRoot = Join-Path $fixture 'Windows sem PowerShell'
$pwshHome = Join-Path $fixture 'PowerShell 7'
$missingHome = Join-Path $fixture 'host ausente'
$fakeConhost = Join-Path $fakeRoot 'System32\conhost.exe'
$fakeWinPs = Join-Path $fakeRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$fakePwsh = Join-Path $pwshHome 'pwsh.exe'
foreach ($file in $fakeConhost, $fakeWinPs, $fakePwsh, (Join-Path $bareRoot 'System32\conhost.exe')) { New-Item -ItemType File -Path $file -Force | Out-Null }
New-Item -ItemType Directory -Path (Join-Path $fixture 'Startup') | Out-Null
$script:StartupLink = Join-Path $fixture 'Startup\TokenBar.lnk'
$script:Root = $fixture
$script:LogPath = Join-Path $fixture 'startup.log'

Assert-Equal (Save-StartupTask -SystemRoot $bareRoot -HostHome $missingHome) $false 'Startup option is not confirmed without an existing PowerShell host'
Assert-Equal $script:RegisterCalls 0 'No startup task is registered without an existing PowerShell host'
Assert-Equal ((Get-Content -LiteralPath $script:LogPath -Raw) -match 'inicializacao com o Windows nao configurada') $true 'Missing startup host is logged'

Assert-Equal (Save-StartupTask -SystemRoot $fakeRoot -HostHome $pwshHome) $true 'Startup task is confirmed from a PowerShell 7 session'
$taskAction = @($script:FakeTask.Actions)[0]
Assert-Equal $taskAction.Execute $fakeConhost 'Startup task runs conhost from the system root'
Assert-Equal ($taskAction.Arguments.StartsWith(('--headless "{0}" ' -f $fakeWinPs))) $true 'PowerShell 7 session uses the system Windows PowerShell, not $PSHOME\powershell.exe'
Assert-Equal ($taskAction.Arguments.EndsWith(('-File "{0}"' -f $script:TrayScript))) $true 'Startup task runs this tokenbar.ps1'
Assert-Equal $taskAction.WorkingDirectory $fixture 'Startup task starts in the project root'
Assert-Equal $script:FakeTask.Settings.ExecutionTimeLimit 'PT0S' 'Startup task has no 72 h execution limit that would kill the tray'
Assert-Equal ([string] $script:FakeTask.Principal.RunLevel) 'Limited' 'Startup task runs without elevation'
Assert-Equal ([string] $script:FakeTask.Principal.LogonType) 'Interactive' 'Startup task runs in the user session, where the tray icon is visible'
Assert-Equal $script:FakeTask.Triggers[0].UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) 'Startup task fires only at the current user logon'
Remove-StartupTask
Assert-Equal ([bool] (Get-StartupTask)) $false 'Disabling the option unregisters the task'

Assert-Equal (Save-StartupTask -SystemRoot $bareRoot -HostHome $pwshHome) $true 'Startup task falls back to the current pwsh.exe'
Assert-Equal (@($script:FakeTask.Actions)[0].Arguments.StartsWith(('--headless "{0}" ' -f $fakePwsh))) $true 'Fallback task points to an existing pwsh.exe'
Remove-StartupTask

$script:RegisterFails = $true
Assert-Equal (Save-StartupTask -SystemRoot $fakeRoot -HostHome $pwshHome) $false 'A refused task registration leaves the option unchecked'
Assert-Equal ((Get-Content -LiteralPath $script:LogPath -Raw) -match 'Acesso negado \(simulado\)') $true 'Refused task registration is logged'
$script:RegisterFails = $false

$validArgs = Get-StartupArguments $fakeWinPs $script:TrayScript
Assert-Equal (Test-StartupCommandCurrent $fakeConhost (Get-StartupArguments (Join-Path $pwshHome 'powershell.exe') $script:TrayScript) $script:TrayScript) $false 'Task pointing to a missing powershell.exe is repaired'
Assert-Equal (Test-StartupCommandCurrent $fakeConhost $validArgs $script:TrayScript) $true 'Valid conhost task is kept'
Assert-Equal (Test-StartupCommandCurrent $fakeConhost (Get-StartupArguments $fakeWinPs 'C:\outro\tokenbar.ps1') $script:TrayScript) $false 'Task pointing to another tokenbar.ps1 is repaired'
Assert-Equal (Test-StartupCommandCurrent (Join-Path $fakeRoot 'System32\wscript.exe') '"x.vbs"' $script:TrayScript) $false 'Legacy wscript command is replaced'

# Migração do atalho na pasta de Inicialização para a tarefa agendada. Sync-StartupRegistration
# usa o host real do sistema só para checar existência; o registro continua falso.
$script:RegisterCalls = 0
Assert-Equal (Sync-StartupRegistration) $false 'Without shortcut or task the option stays off'
Assert-Equal $script:RegisterCalls 0 'Nothing is registered for users who never enabled the option'
New-Item -ItemType File -Path $script:StartupLink | Out-Null
Assert-Equal (Sync-StartupRegistration) $true 'Users of the old shortcut keep starting with Windows'
Assert-Equal (Test-Path -LiteralPath $script:StartupLink) $false 'The old Startup folder shortcut is removed'
Assert-Equal $script:RegisterCalls 1 'The old shortcut becomes a scheduled task'
Assert-Equal (Sync-StartupRegistration) $true 'A current task keeps the option on'
Assert-Equal $script:RegisterCalls 1 'A current task is not registered again'
$script:FakeTask.Actions = @([pscustomobject]@{Execute=$fakeConhost;Arguments=(Get-StartupArguments $fakeWinPs 'C:\outro\tokenbar.ps1')})
Assert-Equal (Sync-StartupRegistration) $true 'A stale task keeps the option on'
Assert-Equal $script:RegisterCalls 2 'A task for another tokenbar.ps1 is registered again'
Assert-Equal (@($script:FakeTask.Actions)[0].Arguments.EndsWith(('-File "{0}"' -f $script:TrayScript))) $true 'Repaired task runs this tokenbar.ps1'
Remove-StartupTask

# Texto acessivel do painel (achado 7): mesmo conteudo das linhas desenhadas com GDI+.
Set-DisabledProviders @()
$a11yClaude = [pscustomobject]@{provider='claude';label='Claude';status='unavailable';stale=$true;collectedAt=$now.AddMinutes(-6).ToString('o');windows=@([pscustomobject]@{id='five_hour';usedPercent=93;resetsAt=$now.AddHours(-1).ToString('o')})}
$a11yCodex = [pscustomobject]@{provider='codex';label='Codex';status='ok';plan='plus';collectedAt=$now.ToString('o');windows=@(
  [pscustomobject]@{id='codex_primary';label='Janela de 5 horas';durationMinutes=300;usedPercent=40.4;resetsAt=$now.AddMinutes(105).ToString('o')},
  [pscustomobject]@{id='codex_secondary';durationMinutes=10080;usedPercent=92;resetsAt='2026-09-07T07:00:00Z'}
)}
$a11yAntigravity = [pscustomobject]@{provider='antigravity';label='Antigravity';status='ok';collectedAt=$now.ToString('o');windows=$null}
$script:Snapshot = [pscustomobject]@{providers=@($a11yClaude,$a11yCodex,$a11yAntigravity)}
Assert-Equal (Get-PanelAccessibleText $now) 'Claude (dados em cache): 5h, 93% usado, renovando. Codex (plano plus): Janela de 5 horas, 40% usado, renova em 1h 45m; sem, 92% usado, renova em 1d 18h. Antigravity: sem dados.' 'Accessible panel text lists every window with usage and reset per provider'
# Motivo da falha: o painel e o texto acessivel dizem por que o provedor esta em cache.
foreach ($case in @(@('auth', $null, 'login'), @('rate-limit', 'HTTP_429', 'HTTP 429'), @('tls', 'SELF_SIGNED_CERT_IN_CHAIN', 'certificado'),
    @('network', 'ECONNRESET', 'rede'), @('network', 'HTTP_503', 'HTTP 503'), @('timeout', $null, 'sem resposta'),
    @('invalid-response', $null, 'resposta inesperada'), @($null, $null, ''), @('auth', 'TOKEN_REVOKED', 'login revogado'),
    @('auth', 'TOKEN_EXPIRED', 'login'), @('auth', 'LOGGED_OUT', 'login encerrado'), @('auth', 'HTTP_401', 'HTTP 401'),@('network', 'HTTP_503 <script>', 'rede'))) {
  $failed = [pscustomobject]@{status='error';failureKind=$case[0];failureCode=$case[1]}
  Assert-Equal (Get-FailureLabel $failed) $case[2] ('Failure label for {0}/{1}' -f $case[0], $case[1])
}
Assert-Equal (Get-FailureLabel ([pscustomobject]@{status='ok';failureKind='tls'})) '' 'A healthy provider never shows a stale failure label'
$a11yClaude | Add-Member -NotePropertyName failureKind -NotePropertyValue 'tls'
$a11yClaude | Add-Member -NotePropertyName failureCode -NotePropertyValue 'SELF_SIGNED_CERT_IN_CHAIN'
Assert-Equal ((Get-PanelAccessibleText $now) -like 'Claude (dados em cache, falha: certificado): 5h, 93% usado*') $true 'Accessible panel text names the failure reason'
$drawsFailure = (Get-TrayFunction 'Write-Panel').Find({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Get-FailureLabel' }, $true)
Assert-Equal ($null -ne $drawsFailure) $true 'Write-Panel draws the failure reason in the provider header'
Set-DisabledProviders @('claude', 'antigravity')
Assert-Equal (Get-PanelAccessibleText $now) 'Codex (plano plus): Janela de 5 horas, 40% usado, renova em 1h 45m; sem, 92% usado, renova em 1d 18h.' 'Accessible panel text follows the provider selection'
Set-DisabledProviders @('claude', 'codex', 'antigravity')
Assert-Equal (Get-PanelAccessibleText $now) 'Nenhum provedor selecionado.' 'Accessible panel text explains an empty selection'
Set-DisabledProviders @()
$script:Snapshot = $null
Assert-Equal (Get-PanelAccessibleText $now) 'Sem dados.' 'Accessible panel text explains missing data'
foreach ($name in 'Update-Tray', 'Show-Panel') {
  $called = (Get-TrayFunction $name).Find({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Update-PanelAccessibility' }, $true)
  Assert-Equal ([bool] $called) $true "$name refreshes the panel accessible text"
}
# O nome que o UI Automation entrega ao leitor de tela, numa janela que nunca e exibida.
Add-Type -AssemblyName System.Windows.Forms, UIAutomationClient, UIAutomationTypes
. ([scriptblock]::Create((Get-TrayFunction 'Update-PanelAccessibility').Extent.Text))
$script:Form = New-Object System.Windows.Forms.Form
try {
  # Update-PanelAccessibility usa o relogio real; 30 s de folga mantem o minuto da contagem.
  $realNow = [DateTimeOffset]::UtcNow
  $script:Snapshot = [pscustomobject]@{providers=@([pscustomobject]@{provider='codex';label='Codex';status='ok';plan='plus';collectedAt=$realNow.ToString('o');windows=@(
    [pscustomobject]@{id='codex_primary';label='Janela de 5 horas';durationMinutes=300;usedPercent=40;resetsAt=$realNow.AddSeconds(105 * 60 + 30).ToString('o')}
  )})}
  Update-PanelAccessibility
  $uiaName = [System.Windows.Automation.AutomationElement]::FromHandle($script:Form.Handle).Current.Name
  Assert-Equal $uiaName 'TokenBar, cotas das assinaturas. Codex (plano plus): Janela de 5 horas, 40% usado, renova em 1h 45m.' 'UI Automation exposes the panel windows, usage and resets as the window name'
} finally {
  $script:Form.Dispose()
  $script:Snapshot = $null
}

# Log da bandeja
$tempLog = Join-Path $fixture 'tray.log'
Write-TrayLog $tempLog 'primeira'
Assert-Equal ((Get-Content $tempLog -Raw) -match "\[$PID\] primeira") $true 'Tray log records timestamp, pid and message'
Set-Content $tempLog ('x' * 210KB)
Write-TrayLog $tempLog 'depois da rotacao'
Assert-Equal (Test-Path ([System.IO.Path]::ChangeExtension($tempLog, 'previous.log'))) $true 'Oversized tray log is rotated'
Assert-Equal ((Get-Content $tempLog -Raw) -match 'depois da rotacao') $true 'Rotated tray log starts fresh'
# Caminho inválido dentro da fixture (achado 6): um arquivo usado como pasta-pai nunca
# vira diretório, em qualquer máquina, e não há destino fora da fixture para escrever.
$parentFile = Join-Path $fixture 'pai-arquivo'
Set-Content -LiteralPath $parentFile -Value 'fixture' -Encoding ASCII
$before = @(Get-ChildItem -LiteralPath $fixture -Recurse -Force | ForEach-Object { $_.FullName }) -join '|'
$threw = $false
try { Write-TrayLog (Join-Path $parentFile 'tray.log') 'ignorada' } catch { $threw = $true }
Assert-Equal $threw $false 'Unwritable log path never throws'
Assert-Equal ((Get-Content -LiteralPath $parentFile -Raw).Trim()) 'fixture' 'Failed log write leaves the parent file untouched'
Assert-Equal (@(Get-ChildItem -LiteralPath $fixture -Recurse -Force | ForEach-Object { $_.FullName }) -join '|') $before 'Failed log write creates nothing in the fixture'

Remove-TestFixture
Assert-Equal (Test-Path -LiteralPath $fixture) $false 'Test fixture is removed'
Write-Output "$passed Windows tray checks passed."
