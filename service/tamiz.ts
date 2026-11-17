// El tamiz léxico: lo barato y determinista que se mira ANTES de llamar al modelo.
//
// INVARIANTE: sobre vocabulario de riesgo, el `seguir` del residente NUNCA es final. Si el texto nombra dinero,
// credenciales o una publicación fuera, la puerta no abre aunque la rúbrica apruebe; el motivo pasa a ser del tamiz.
// Los patrones de PROSA no son riesgo: solo dejan `marca=prosa-parN` en la traza y no cambian ningún veredicto.
import type { Riesgo } from "./rules.ts";

// Solo vocabulario que nombra el acto, no el tema: «el token de lectura» en una frase no es mover credenciales,
// «rota el token» sí. Se ordena de más grave a menos: el primero que dispara manda.
//
// Son las familias de D6/D7/D8 dichas sin el literal, más lo irreversible: lo único donde el «seguir» del residente no
// puede valer, porque no es cuestión de criterio. Los verbos de borrado en prosa NO entran: ya los cazan D1/D2/D5 en su
// literal, y en prosa son la mitad de las legítimas medidas («borra los temporales de mi worktree»).
const RIESGO: Array<[Riesgo, string, RegExp, ((t: string) => string)?]> = [
  ["dinero", "dinero", /\b(paga|pagar|pago|transfer\w+|bizum|cobrar|cobro|factura\w*|reembols\w+|compra\w*|contrata\w*|suscripci[oó]n)\b/i],
  ["dinero", "credenciales", /\b(rota\w*|rotaci[oó]n|regenera\w*|revoca\w*|filtrad[oa]s?|expone\w*)\b[^\n]{0,40}\b(clave|token|contrase[ñn]a|secreto|credencial\w*|api[ _-]?key|ssh)\b/i],
  ["dinero", "credenciales", /\b(clave|token|contrase[ñn]a|secreto|credencial\w*|api[ _-]?key)\b[^\n]{0,40}\b(rota\w*|regenera\w*|revoca\w*|publ\w+|sube\w*|compart\w+)/i],
  ["dinero", "publicar fuera", /\b(publica|publicar|anuncia|anunciar)\w*\b[^\n]{0,40}\b(web|internet|clientes?|p[uú]blico|redes|tienda)\b/i],
  ["alto", "irreversible", /\b(irreversible|no se deshace|sin vuelta atr[aá]s)\b/i],
  // La entrega de un ticket es su PR fusionada POR LA PUERTA (`company-aprobar fusionar`, que solo fusiona en LISTA: CI verde y
  // revisión); eso es `bajo` y lo dice la rúbrica (16-11). Saltarse la puerta con el gh de verdad, la API de merge o
  // `--admin` (que pasa por encima de la protección de la rama) es `alto` sin preguntar al modelo. `gh pr merge` a secas NO
  // entra: en los hosts de la compañía (x86, paseo-0, company-0) `gh` es el envoltorio de company-aprobar, así que es la misma
  // puerta y la rúbrica lo deja en bajo (17-11); y las B escriben «company-aprobar fusionar … (nunca gh pr merge)» (auditoría
  // 09-11 y 15-11). Medido el 16-11: 0 de 2715 sugerencias de la
  // auditoría nombran `--admin`, `gh.real pr merge` o la API de merge (REST o la mutación GraphQL). Lo que se nombra para
  // prohibirlo no es la orden: el tamiz no mira las cláusulas negadas (`sinNegadas`) y esas las juzga la rúbrica.
  ["alto", "fusión sin la puerta",
    /--admin\b|\bgh\.real\b[^\n;|&]{0,40}\bpr\s+merge\b|\bgh(?:\.real)?\b[^\n;|&]{0,40}\bapi\b[^\n;|&]{0,120}\/pulls\/\d+\/merge\b|\bmergePullRequest\b/i,
    (t) => sinNegadas(t)],
];

// Una cláusula que EMPIEZA por negación nombra el mando para prohibirlo: «No fusiones la PR 371 con --admin», «(nunca gh pr
// merge --admin)». En el eval del 16-11 las tres sugerencias buenas del caso «fusion-sin-revision-no-se-fuerza» decían eso y
// el tamiz las vetaba. Se quitan antes de mirar y lo que quitan no se aprueba solo: lo juzga la rúbrica, que nombra `--admin`
// como alto y lee la negación. Las cláusulas se cortan en `. ` `;` `:` `,` paréntesis y saltos de línea (no en el punto de
// `gh.real`): «No esperes, fusiona con --admin» sigue vetado, porque la segunda cláusula no está negada.
const NEGADA = /^\s*(no|nunca|jam[aá]s|ni|sin)\b/i;
function sinNegadas(t: string): string {
  return t.split(/\.\s|[;:,()\n]/).filter((c) => !NEGADA.test(c)).join("\n");
}

// Prosa: no dice nada del riesgo, pero repetida en la auditoría delata al modelo rellenando. Nunca veta.
const PROSA: RegExp[] = [
  /\b(por supuesto|claro que s[ií]|c[oó]mo no|vamos all[aá]|aqu[ií] tienes|perfecto,? vamos)\b/i,
  /\b(no dudes en|espero que|si necesitas algo|quedo atento)\b/i,
];

type Tamiz = { riesgo: Riesgo | null; patron: string; marcas: string[] };

/** El tamiz de un texto. Barato, sin red, y nunca lanza: no puede tumbar la puerta. */
export function tamizar(texto: string): Tamiz {
  const t = texto.normalize("NFKC");
  const marcas: string[] = [];
  PROSA.forEach((p, i) => { if (p.test(t)) marcas.push(`marca=prosa-par${i + 1}`); });
  for (const [riesgo, patron, re, mirar] of RIESGO) if (re.test(mirar ? mirar(t) : t)) return { riesgo, patron, marcas };
  return { riesgo: null, patron: "", marcas };
}