#!/usr/bin/env bash
# El plugin se actualiza solo: si el tronco de GitHub trae un commit que no está desplegado, lo baja y lo despliega
# (deploy.sh enlaza `current` y recarga el plugin). Lo lanza el propio server del plugin cada 5 min, así que no hace falta
# acordarse de nada tras un merge. Solo `git` y `node`: ni clon, ni credenciales, ni el `gh` del PATH del daemon.
# shortcut: es sondeo, no evento — GitHub no avisa a un plugin local. Si algún día hay webhook, esto pasa a ser su hook.
set -euo pipefail
repo="https://github.com/pocharlies-org/paseo-sugiere"
version=$(node -p "require('$(dirname "$(dirname "$0")")/package.json').version")
destino="$HOME/.local/share/paseo-sugiere/paseo-plugin"
log="$HOME/.local/state/paseo-sugiere/autodeploy.log"
sha=$(git ls-remote "$repo" main | cut -c1-12)
[ -n "$sha" ] && [ ! -d "$destino/$version-$sha" ] || exit 0

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if git clone -q --depth 1 "$repo" "$tmp/checkout" 2>/dev/null; then
  mkdir -p "$(dirname "$log")"
  DEPLOY_SHA="$sha" bash "$tmp/checkout/scripts/deploy.sh" "$tmp/checkout" >>"$log" 2>&1
fi
