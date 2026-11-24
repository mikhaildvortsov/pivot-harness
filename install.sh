#!/usr/bin/env sh
# Pivot harness installer for macOS and Linux. Installs the Pivot engine if it is missing, puts the harness into ~/.pi/agent and links `pivot`
# into ~/.local/bin. It never reads, asks for or writes API keys: add them yourself (see the end of the output).
# Override for tests or forks: PIVOT_REPO=<git url>, PIVOT_DEST=<target folder>.
set -eu
REPO="${PIVOT_REPO:-https://github.com/mikhaildvortsov/pivot-harness}"
DEST="${PIVOT_DEST:-$HOME/.pi/agent}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "$1 не найден. $2" >&2; exit 1; }; }
need git "Установите git."
need node "Установите Node.js 22.19 или новее: https://nodejs.org"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' \
  || { echo "Нужен Node.js 22.19 или новее, у вас $(node -v)." >&2; exit 1; }

if ! command -v pi >/dev/null 2>&1; then
  echo "Ядро Pivot не найдено, ставлю: npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
fi

if [ -d "$DEST/.git" ]; then
  echo "Харнес уже установлен в $DEST, обновляю (git pull)."
  git -C "$DEST" pull --ff-only
else
  backup=""
  if [ -e "$DEST" ]; then
    backup="$DEST.bak-$(date +%Y%m%d-%H%M%S)"
    mv "$DEST" "$backup"
    echo "Старая папка настроек перенесена в $backup (ничего не удалено)."
  fi
  mkdir -p "$(dirname "$DEST")"
  if ! git clone "$REPO" "$DEST"; then
    [ -n "$backup" ] && mv "$backup" "$DEST"
    echo "git clone не удался. Репозиторий закрытый: попросите владельца добавить вас в Collaborators и войдите в GitHub." >&2
    exit 1
  fi
  if [ -n "$backup" ]; then
    # keep the user's own logins and chat history: they are not part of the harness
    for name in auth.json trust.json models-store.json sessions; do
      [ -e "$backup/$name" ] && cp -R "$backup/$name" "$DEST/$name"
    done
    echo "Ваши входы и история чатов (auth.json, sessions) скопированы из старой папки."
  fi
fi

sh "$DEST/bin/install"

echo
echo "Готово. Ключи НЕ установлены: добавьте свои в ~/.zshrc или ~/.profile и откройте новый терминал:"
echo '  export NANOGPT_API_KEY="ваш_ключ_nanogpt"'
echo '  export GONKA_API_KEY="ваш_ключ_gonka"'
echo "Подписка Anthropic: запустите pivot и введите /login. Затем: cd /путь/к/проекту && pivot"
