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
# El worker del daemon de Atlantic (pod paseo-0) no trae el bin global de npm en el PATH: sin esto, «paseo: command not found»
# en cada vuelta (medido 01-11: 779 fallos en el log) y el plugin no se actualizaba nunca.
export PATH="$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
full=$(git ls-remote "$repo" main | cut -f1)
sha=${full:0:12}
[ -n "$sha" ] || exit 0
# Instalado por git (`paseo plugin add git:…`): lo que corre es el checkout del host, no `current`; la versión viva es su commit.
viva=$(paseo plugin ls --json | node -e "let s='';process.stdin.on('data',x=>s+=x).on('end',()=>{const p=JSON.parse(s).find(p=>p.id==='paseo-sugiere');process.stdout.write(p&&p.source==='git'?p.commit:'')})")
if [ -e "$destino"/*-"$sha" ] && { [ -z "$viva" ] || [ "$viva" = "$full" ]; }; then
  echo "$(date -u +%FT%TZ) al día: $sha" >>"$log"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git clone -q --depth 1 "$repo" "$tmp/checkout"
DEPLOY_SHA="$sha" DEPLOY_REF="$full" bash "$tmp/checkout/scripts/deploy.sh" "$tmp/checkout" >>"$log"
