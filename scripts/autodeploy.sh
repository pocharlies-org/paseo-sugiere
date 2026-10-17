#!/usr/bin/env bash
# El plugin se actualiza solo: si el tronco de GitHub trae un commit que no está desplegado, lo baja y llama a deploy.sh
# (que enlaza `current` y recarga el plugin). Lo lanza el propio server del plugin al arrancar y cada 5 min, así que no hay que
# acordarse de nada tras un merge. Solo `git`: ni clon propio, ni credenciales, ni el `gh` que no está en el PATH del daemon.
# shortcut: es sondeo, no evento — GitHub no avisa a un plugin local. Si algún día hay webhook, esto pasa a ser su hook.
set -euo pipefail
# Todo lo que falle se lee aquí: el que llama es un server sin consola con stdio ignorado (medido 17-10: sin esto, el script
# moría en silencio y nadie sabía por qué la píldora no se actualizaba).
log="$HOME/.local/state/paseo-sugiere/autodeploy.log"
mkdir -p "$(dirname "$log")"
exec 2>>"$log"
repo="https://github.com/pocharlies-org/paseo-sugiere"
destino="$HOME/.local/share/paseo-sugiere/paseo-plugin"
# La versión no se lee del paquete desplegado: `files` no incluye package.json, así que no está en la carpeta instalada.
# Basta con que exista cualquier carpeta terminada en el sha.
sha=$(git ls-remote "$repo" main | cut -c1-12)
[ -n "$sha" ] && [ ! -e "$destino"/*-"$sha" ] || exit 0

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git clone -q --depth 1 "$repo" "$tmp/checkout"
DEPLOY_SHA="$sha" bash "$tmp/checkout/scripts/deploy.sh" "$tmp/checkout" >>"$log"
