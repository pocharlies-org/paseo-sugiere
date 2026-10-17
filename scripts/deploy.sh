#!/usr/bin/env bash
# Empaqueta el plugin como el de cuentas: carpeta versionada `<version>-<git sha>` + enlace `current`, y el daemon apunta al
# `current` (ruta estable), no a un clon. Mismo patrón que claude-cuenta-paseo.py; aquí el origen es el trunk del repo.
set -euo pipefail
# Origen: el árbol que se le pasa (por defecto el clon del repo). Con `DEPLOY_SHA` se despliega un árbol sin git
# (autodeploy.sh baja el tarball del tronco), que es como el plugin se actualiza solo.
cd "${1:-$(cd "$(dirname "$0")/.." && pwd)}"
version=$(node -p "require('./package.json').version")
id=$(node -p "require('./paseo-plugin.json').id")
rango=$(node -p "require('./paseo-plugin.json').requirements.paseo")
sha="${DEPLOY_SHA:-$(git rev-parse --short=12 HEAD)}"
destino="$HOME/.local/share/paseo-sugiere/paseo-plugin"
carpeta="$destino/$version-$sha"

# Fuera de rango: se dice y no se instala, sin rojo (igual que en cuentas). Solo >= y <, los dos del manifiesto.
pv=$(paseo --version | tr -d '[:space:]')
node -e "
const [v,r]=process.argv.slice(1);
const n=s=>s.split('.').map(Number);
const cmp=(a,b)=>{const[x,y,z]=n(a),[p,q,o]=n(b);return x-p||y-q||z-o};
for(const c of r.split(/\s+/)){const m=c.match(/^(>=|<)(\d+\.\d+\.\d+)\$/);if(!m)process.exit(1);
  const d=cmp(v,m[2]);if(m[1]==='>='&&d<0)process.exit(1);if(m[1]==='<'&&d>=0)process.exit(1)}" "$pv" "$rango" \
  || { echo "paseo $pv no cumple '$rango': no se despliega"; exit 0; }

if [ ! -d "$carpeta" ]; then
  mkdir -p "$carpeta"
  # solo lo que package.json declara en `files`
  node -e "
  const fs=require('fs'),path=require('path');
  for(const f of require('./package.json').files){
    const s=path.resolve(f); if(!fs.existsSync(s)){console.error('falta '+f);process.exit(1)}
    fs.cpSync(s, path.join(process.argv[1], f), {recursive:true})
  }" "$carpeta"
fi
actual="$destino/current"
if [ "$(readlink "$actual" 2>/dev/null || true)" != "$version-$sha" ]; then
  ln -s "$version-$sha" "$actual.tmp.$$" && mv -T "$actual.tmp.$$" "$actual"
  echo "current -> $version-$sha"
fi
if paseo plugin ls --no-headers 2>/dev/null | awk '{print $1}' | grep -qx "$id"; then
  paseo plugin reload "$id"
else
  paseo plugin install "$actual"
fi
echo "desplegado $id $version-$sha (paseo $pv)"
