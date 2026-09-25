# Notification Telegram pour les hooks Claude Code (Stop / Notification).
# Lit TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID dans l'environnement (processus puis utilisateur).
# N'envoie jamais le contenu de la conversation (données de santé possibles) : uniquement l'événement.
# Sort toujours avec le code 0 pour ne jamais bloquer Claude Code.

$ErrorActionPreference = 'SilentlyContinue'

function Get-Var($name) {
    $v = [Environment]::GetEnvironmentVariable($name, 'Process')
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($name, 'User') }
    return $v
}

$token = Get-Var 'TELEGRAM_BOT_TOKEN'
$chatId = Get-Var 'TELEGRAM_CHAT_ID'
if (-not $token -or -not $chatId) { exit 0 }

$payload = $null
try { $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch {}

$event = if ($payload) { $payload.hook_event_name } else { '' }
$check = [char]::ConvertFromUtf32(0x2705)
$wait = [char]::ConvertFromUtf32(0x23F3)

switch ($event) {
    'Stop'         { $text = "$check SPORTOOP : Claude a fini sa tache." }
    'Notification' {
        $detail = if ($payload.message) { $payload.message } else { 'Claude attend ta reponse.' }
        $text = "$wait SPORTOOP : $detail"
    }
    default        { $text = "SPORTOOP : evenement $event" }
}

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $body = @{ chat_id = $chatId; text = $text } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/sendMessage" -Method Post `
        -ContentType 'application/json; charset=utf-8' `
        -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 10 | Out-Null
} catch {}

exit 0
