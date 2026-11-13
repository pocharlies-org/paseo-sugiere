#!/usr/bin/env python3
"""Regenera test/fixtures/cierre.json con el parser REAL del supervisor (fuente de verdad de la gramática del cierre, spec §12):
lee del tronco de x86-host-runtime `company_runtime.esperas_de`/`paras_de`, `company-sesion` `estado_de` y `DINERO_RE`, y calcula lo
esperado de cada caso. Uso: `python3 test/fixtures/genera_cierre.py [~/src/x86-host-runtime-pocharlies] > test/fixtures/cierre.json`."""
import json, os, subprocess, sys

X86 = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/src/x86-host-runtime-pocharlies")
REF = sys.argv[2] if len(sys.argv) > 2 else "origin/main"
show = lambda ruta: subprocess.run(["git", "-C", X86, "show", f"{REF}:{ruta}"], check=True, capture_output=True, text=True).stdout
trozo = lambda texto, desde, hasta: texto[texto.index(desde):texto.index(hasta)]
fuente = "\n".join(["import os, re, sys, time", "from datetime import datetime, timezone",
    trozo(show("libexec/company_runtime.py"), "ESPERA_RE = re.compile(", "# ------------------------------------------------------------------ qué pide la épica"),
    trozo(show("libexec/company-sesion"), "ESTADO_RE = re.compile(", "# Lo que el cto lanza él mismo"),
    next(l for l in show("libexec/jira-epic-trigger.py").splitlines() if l.startswith("DINERO_RE = "))])
g = {}
exec(compile(fuente, "gramatica_supervisor", "exec"), g)

# (nombre, texto, entregado): `entregado` es solo del autopilot (TS); lo demás lo dice el Python.
CASOS = [
 ("espera ci con flecha", "Abrí el PR.\nESPERA: ci pocharlies-org/paseo-sugiere#77 → fusiono si está verde", None),
 ("espera merge en viñeta y backticks", "Hecho.\n- `ESPERA: merge pocharlies-org/k8s-sugiere-pocharlies#14` → miro ArgoCD", None),
 ("espera review", "ESPERA: review pocharlies-org/dgx-infra#901 -> contesto al juez", None),
 ("espera run con id", "ESPERA: run pocharlies-org/paseo-sugiere 123456789 → leo el log", None),
 ("espera run sin id no vale", "ESPERA: run pocharlies-org/paseo-sugiere → leo el log", None),
 ("espera argocd con commit", "ESPERA: argocd sugiere 06defc7 → pruebo el endpoint", None),
 ("espera fichero", "ESPERA: fichero /tmp/salida.json → la leo", None),
 ("espera jira", "ESPERA: jira TAREA-1000002 → sigo cuando se cierre", None),
 ("espera sesion registrada", "ESPERA: sesion 00000000-0000-4000-8000-0000000000ab → integro el resultado", None),
 ("espera sesion UUID invalido", "ESPERA: sesion no-es-uuid → nada", None),
 ("espera sesion mayuscula invalida", "ESPERA: sesion 00000000-0000-4000-8000-0000000000AB → nada", None),
 ("espera fecha con hora", "ESPERA: fecha 2026-11-08 09:30 → reviso la cola", None),
 ("espera fecha imposible no vale", "ESPERA: fecha 2026-02-30 → nada", None),
 ("espera sin objetivo no vale", "ESPERA: ci el pipeline del repo → sigo", None),
 ("espera repetida cuenta una", "ESPERA: ci pocharlies-org/x#1 → a\nESPERA: ci pocharlies-org/x#1 → b", None),
 ("espera en prosa no cuenta", "Dejo una ESPERA: ci pocharlies-org/x#1 para luego.", None),
 ("para dani sin dinero", "Listo el plan.\n\nPARA DANI: ¿apruebas el plan con las propuestas por defecto?", None),
 ("para dani con euros", "PARA DANI (dinero): comprar el dominio cuesta 120 € al año, ¿lo pago?", None),
 ("para dani con dolares delante", "PARA DANI: la API cobra $45 al mes, ¿la contrato?", None),
 ("para dani etiqueta dinero sin importe", "PARA DANI (dinero): nada de dinero, solo confirma el nombre", None),
 ("para dani decimales eur", "PARA DANI: el plan cuesta 12,50 eur al mes", None),
 ("para dani alcance", "PARA DANI (alcance): el brief pide X pero lo correcto es Y, ¿cambio el alcance?", None),
 ("para it y security en orden", "PARA IT: falta el token del runner\n\nPARA SECURITY: revisa el secreto nuevo", None),
 ("para dani y espera a la vez", "ESPERA: ci pocharlies-org/x#9 → fusiono\n\nPARA DANI: ¿le pongo otro nombre al servicio?", None),
 ("estado entrega", "Todo verificado en vivo.\nESTADO: ENTREGA", None),
 ("estado entrega en negrita", "Hecho.\n**ESTADO: ENTREGA** — PR fusionada y desplegada", None),
 ("estado pregunta antiguo", "ESTADO: PREGUNTA ¿sigo con la fase 2?", None),
 ("entregado con clave y url", "ESTADO: ENTREGA\nAUTOPILOT: ENTREGADO TAREA-1000001 https://artefactos.example.com/entrega.html",
  {"key": "TAREA-1000001", "url": "https://artefactos.example.com/entrega.html"}),
 ("entregado en backticks", "ESTADO: ENTREGA\n`AUTOPILOT: ENTREGADO TAREA-1000003 https://artefactos.example.com/a.html`",
  {"key": "TAREA-1000003", "url": "https://artefactos.example.com/a.html"}),
 ("entregado de ejemplo no cierra", "5. Último renglón: `AUTOPILOT: ENTREGADO <KEY> <url>`\n`AUTOPILOT: ENTREGADO <KEY> <url>`", None),
 ("entregado citado a mitad de turno no cierra", "El cierre será `AUTOPILOT: ENTREGADO TAREA-1000002 https://artefactos.example.com/b.html` al terminar.\nESPERA: ci pocharlies-org/x#1 → fusiono", None),
 ("nada", "He leído el código y sigo mañana.", None),
]

casos = []
for nombre, texto, entregado in CASOS:
    paras = g["paras_de"](texto)
    dani = next((t for q, t in paras if q == "DANI"), None)
    casos.append({"nombre": nombre, "texto": texto, "esperas": [e["linea"] for e in g["esperas_de"](texto, 1762500000.0)],
                  "paras": [q for q, _ in paras], "para_dani": dani, "estado": list(g["estado_de"](texto)),
                  "dinero": bool(dani is not None and g["DINERO_RE"].search(dani)), "entregado": entregado})
json.dump({"_fuente": f"x86-host-runtime {REF}: company_runtime.esperas_de/paras_de, company-sesion estado_de, "
           "jira-epic-trigger.DINERO_RE. `entregado` es solo del autopilot (TS). Regenerar con test/fixtures/genera_cierre.py.",
           "casos": casos}, sys.stdout, ensure_ascii=False, indent=1)
print()
