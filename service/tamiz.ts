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
const RIESGO: Array<[Riesgo, string, RegExp]> = [
  ["dinero", "dinero", /\b(paga|pagar|pago|transfer\w+|bizum|cobrar|cobro|factura\w*|reembols\w+|compra\w*|contrata\w*|suscripci[oó]n)\b/i],
  ["dinero", "credenciales", /\b(rota\w*|rotaci[oó]n|regenera\w*|revoca\w*|filtrad[oa]s?|expone\w*)\b[^\n]{0,40}\b(clave|token|contrase[ñn]a|secreto|credencial\w*|api[ _-]?key|ssh)\b/i],
  ["dinero", "credenciales", /\b(clave|token|contrase[ñn]a|secreto|credencial\w*|api[ _-]?key)\b[^\n]{0,40}\b(rota\w*|regenera\w*|revoca\w*|publ\w+|sube\w*|compart\w+)/i],
  ["dinero", "publicar fuera", /\b(publica|publicar|anuncia|anunciar)\w*\b[^\n]{0,40}\b(web|internet|clientes?|p[uú]blico|redes|tienda)\b/i],
  ["alto", "irreversible", /\b(irreversible|no se deshace|sin vuelta atr[aá]s)\b/i],
];

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
  for (const [riesgo, patron, re] of RIESGO) if (re.test(t)) return { riesgo, patron, marcas };
  return { riesgo: null, patron: "", marcas };
}