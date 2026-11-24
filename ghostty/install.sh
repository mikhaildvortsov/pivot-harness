#!/usr/bin/env sh
# Installs Ghostty (macOS, Homebrew) and links the Pivot config + shader. Safe to re-run.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
if [ "$(uname)" = "Darwin" ] && [ ! -d /Applications/Ghostty.app ]; then brew install --cask ghostty; fi
mkdir -p "$HOME/.config/ghostty"
ln -sf "$here/config" "$HOME/.config/ghostty/config"
# the config refers to the shader by this path; keep it valid if the repo lives elsewhere
if [ "$here" != "$HOME/.pi/agent/ghostty" ]; then
  mkdir -p "$HOME/.pi/agent" && ln -sfn "$here" "$HOME/.pi/agent/ghostty"
fi
echo "Ghostty config linked: ~/.config/ghostty/config -> $here/config"
