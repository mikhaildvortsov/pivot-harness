# Pivot harness installer for Windows (PowerShell). Installs the Pivot engine if it is missing, puts the harness into %USERPROFILE%\.pi\agent
# and adds its bin folder to the user PATH. It never reads, asks for or writes API keys: add them yourself (see the end of the output).
param(
	[string]$Repo = "https://github.com/mikhaildvortsov/pivot-harness",
	[string]$Dest = (Join-Path $env:USERPROFILE ".pi\agent"),
	[switch]$NoPath
)
$ErrorActionPreference = "Stop"

function Need([string]$cmd, [string]$hint) {
	if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd не найден. $hint" }
}
Need git "Установите Git for Windows: https://git-scm.com/download/win (Pivot запускает команды через Git Bash)."
Need node "Установите Node.js 22.19 или новее: https://nodejs.org"
$nodeVer = [version]((node -v).TrimStart("v"))
if ($nodeVer -lt [version]"22.19.0") { throw "Нужен Node.js 22.19 или новее, у вас $nodeVer." }

if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
	Write-Host "Ядро Pivot не найдено, ставлю: npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
	npm install -g --ignore-scripts "@earendil-works/pi-coding-agent"
	if ($LASTEXITCODE -ne 0) { throw "Не удалось установить ядро Pivot через npm." }
}

if (Test-Path (Join-Path $Dest ".git")) {
	Write-Host "Харнес уже установлен в $Dest, обновляю (git pull)."
	git -C $Dest pull --ff-only
	if ($LASTEXITCODE -ne 0) { throw "git pull не удался. Если вы правили файлы харнеса, сохраните их и повторите." }
} else {
	$backup = $null
	if (Test-Path $Dest) {
		$backup = "$Dest.bak-" + (Get-Date -Format "yyyyMMdd-HHmmss")
		Move-Item $Dest $backup
		Write-Host "Старая папка настроек перенесена в $backup (ничего не удалено)."
	}
	New-Item -ItemType Directory -Force -Path (Split-Path $Dest) | Out-Null
	git clone $Repo $Dest
	if ($LASTEXITCODE -ne 0) {
		if ($backup) { Move-Item $backup $Dest }
		throw "git clone не удался. Репозиторий закрытый: попросите владельца добавить вас в Collaborators и войдите в GitHub."
	}
	if ($backup) {
		# keep the user's own logins and chat history: they are not part of the harness
		foreach ($name in "auth.json", "trust.json", "models-store.json", "sessions") {
			$src = Join-Path $backup $name
			if (Test-Path $src) { Copy-Item $src (Join-Path $Dest $name) -Recurse -Force }
		}
		Write-Host "Ваши входы и история чатов (auth.json, sessions) скопированы из старой папки."
	}
}

if (-not $NoPath) {
	$bin = Join-Path $Dest "bin"
	$user = [Environment]::GetEnvironmentVariable("Path", "User")
	if (($user -split ";") -notcontains $bin) {
		[Environment]::SetEnvironmentVariable("Path", ($user.TrimEnd(";") + ";" + $bin), "User")
		Write-Host "Папка $bin добавлена в PATH пользователя."
	}
}

Write-Host ""
Write-Host "Готово. Ключи НЕ установлены: впишите свои (потом откройте новый терминал):"
Write-Host '  setx NANOGPT_API_KEY "ваш_ключ_nanogpt"'
Write-Host '  setx GONKA_API_KEY "ваш_ключ_gonka"'
Write-Host "Подписка Anthropic: запустите pivot и введите /login. Затем: cd путь\к\проекту; pivot"
