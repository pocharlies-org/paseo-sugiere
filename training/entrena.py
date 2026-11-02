#!/usr/bin/env python3
"""Entrena el head del clasificador de la puerta y escribe sus pesos.

Un caso del corpus es `{resumen, criterio, sugerencia, veredicto:{ok}}`: `permitir` si la puerta de hoy lo aprobó,
`escalar` si no. El texto que se embebe es el mismo que verá el head en producción: ticket, criterio y mensaje propuesto.

Es una regresión ridge (forma cerrada, numpy pelado: sin dependencias nuevas) sobre la embedding de bge-m3. El umbral no
se hereda: se calibra con la curva cobertura/seguridad de este corpus — el más bajo que no deja pasar ningún `escalar`.

    training/entrena.py --corpus ~/.company/sugiere/corpus.jsonl --salida pesos.json
"""
import argparse
import json
import sys
import urllib.request

import numpy as np

EMBED = "http://bge-m3-embedding.llm.svc:8000"
ETIQUETAS = ["permitir", "escalar"]
LAMBDA = 1.0


def texto(caso: dict) -> str:
    return "\n".join(p for p in (caso.get("resumen"), caso.get("criterio"), caso.get("sugerencia")) if p)


def embeddings(textos: list[str], lote: int = 20, url: str = EMBED) -> np.ndarray:
    filas = []
    for i in range(0, len(textos), lote):
        trozo = [t[:4000] for t in textos[i:i + lote]]
        req = urllib.request.Request(f"{url}/embed", data=json.dumps({"inputs": trozo}).encode(),
                                     method="POST", headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            filas.extend(json.loads(r.read()))
    return np.asarray(filas, dtype=np.float64)


def entrena(x: np.ndarray, y: np.ndarray, lam: float = LAMBDA) -> tuple[np.ndarray, np.ndarray]:
    """Ridge multi-salida en forma cerrada: W = (XᵀX + λI)⁻¹ Xᵀ Y, con columna de sesgo."""
    a = np.hstack([x, np.ones((x.shape[0], 1))])
    reg = lam * np.eye(a.shape[1])
    reg[-1, -1] = 0.0                      # el sesgo no se regulariza
    w = np.linalg.solve(a.T @ a + reg, a.T @ y)
    return w[:-1].T, w[-1]


def probabilidades(x: np.ndarray, pesos: np.ndarray, sesgo: np.ndarray) -> np.ndarray:
    z = x @ pesos.T + sesgo
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def calibra(p: np.ndarray, permitir_real: np.ndarray) -> tuple[float, dict]:
    """El umbral más bajo que no permite ningún caso que deba escalar; y lo que deja pasar."""
    malos = p[~permitir_real, 0]
    techo = float(malos.max()) + 1e-6 if len(malos) else 0.0
    umbral = min(max(techo, 0.5), 1.0)
    permite = (p[:, 0] >= umbral).astype(bool)
    return umbral, {
        "casos": int(len(permitir_real)),
        "permitir_reales": int(permitir_real.sum()),
        "escalar_reales": int((~permitir_real).sum()),
        "coverage": round(float(permite.mean()), 3),
        "permite_benignos": int((permite & permitir_real).sum()),
        "permite_destructivos": int((permite & ~permitir_real).sum()),
        "umbral": round(umbral, 3),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--salida", required=True)
    ap.add_argument("--lote", type=int, default=20)
    ap.add_argument("--embed", default=EMBED, help="URL del servicio de embeddings (desde fuera del clúster, la ClusterIP)")
    args = ap.parse_args()

    casos = [json.loads(l) for l in open(args.corpus) if l.strip()]
    if not casos:
        sys.exit("corpus vacío")
    x = embeddings([texto(c) for c in casos], args.lote, args.embed)
    permitir_real = np.array([bool(c["veredicto"].get("ok")) for c in casos])
    y = np.eye(len(ETIQUETAS))[(~permitir_real).astype(int)]     # 0 = permitir, 1 = escalar
    pesos, sesgo = entrena(x, y)
    umbral, medidas = calibra(probabilidades(x, pesos, sesgo), permitir_real)
    medidas["clases"] = sorted(set(permitir_real.tolist()))
    json.dump({"etiquetas": ETIQUETAS, "pesos": pesos.tolist(), "sesgo": sesgo.tolist(), "umbral": umbral},
              open(args.salida, "w"))
    print(json.dumps(medidas, ensure_ascii=False))
    if len(medidas["clases"]) == 1:
        print("AVISO: el corpus es de una sola clase; el head no puede permitir nada (coverage 0) hasta tener benignos.",
              file=sys.stderr)


if __name__ == "__main__":
    main()