// Las reglas duras del dictamen: lo que decide sin modelo, antes de Jev. Lista CERRADA (docs/servicio-sugiere.md §4):
// añadir una regla es cambiar la especificación, no el código.
//
// El texto llega normalizado (NFKC, sin espacios de borde) y se juzga entero, también dentro de bloques de código.

export type Riesgo = "ninguno" | "bajo" | "alto" | "dinero";
export type Regla = { id: string; riesgo: Riesgo; motivo: string; patrones: RegExp[] };

const R = (id: string, riesgo: Riesgo, motivo: string, ...patrones: RegExp[]): Regla => ({ id, riesgo, motivo, patrones });

export const REGLAS: Regla[] = [
  R("D1", "alto", "borrado o sobrescritura de ficheros",
    /\brm\s+(-[^\s]+\s+)*-[^\s]*[rf]/,
    /\bfind\b[^\n]*\s-delete\b/,
    /\bshred\b/,
    /\bmkfs(\.\w+)?\b/,
    /\bdd\b[^\n]*\bof=\/dev\//,
    />\s*\/dev\/(sd|nvme|disk)/),
  R("D2", "alto", "kubernetes destructivo",
    /\bkubectl\s+delete\b/,
    /\bkubectl\b[^\n]*\s--force\b/,
    /\bkubectl\s+drain\b/,
    /\bargocd\s+app\s+delete\b/,
    /\bhelm\s+(uninstall|delete)\b/),
  R("D3", "dinero", "perfil de cómputo: lo decide Dani",
    /gpu-arbiter-state/,
    /\bkubectl\s+scale\b/,
    /\bcompute_mode\b/),
  R("D4", "alto", "git destructivo",
    /\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b|[^\s]*\+[^\s]*:[^\s]*)/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+clean\s+-[^\s]*f/,
    /\bgit\s+branch\s+-D\b/),
  R("D5", "dinero", "borrado de datos: lo decide Dani",
    /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA|INDEX)\b/,
    /\bDELETE\s+FROM\b/,
    /\bpg_restore\b/,
    /\bpsql\b[^\n]*\bdrop\b/),
  R("D6", "dinero", "importe o pago en el mensaje",
    /(€|\$|£)\s?\d/,
    /\d+([.,]\d+)?\s?(€|eur|usd|gbp)/,
    /\b(pagar|pago|transferencia|bizum|adeudo|domiciliaci[oó]n|reembolso|comprar|checkout|tarjeta)\b/,
    /confirmar_pago/),
  R("D7", "dinero", "secretos o credenciales: lo decide Dani",
    /\bop\s+(item|document|vault)\s+(create|edit|delete)\b/,
    /\bkubectl\s+delete\s+secret\b/,
    /\b(passwd|chpasswd)\b/,
    /\bsysadminctl\b[^\n]*-newPassword/,
    /\bgh\s+auth\s+(login|refresh)\b/,
    /\bssh-keygen\b/),
  R("D8", "dinero", "publicación fuera: lo decide Dani",
    /\bsocial_(publish|send_|approve_draft)\w*\b/,
    /\bgmail_send\b/,
    /publish_html[^\n]*public\s*=\s*true/,
    /\b(npm|twine|cargo)\s+publish\b/,
    /\bgh\s+release\b[^\n]*upload/),
  R("D9", "alto", "programado: fuera del brief",
    /\bcrontab\b/,
    /\bsystemctl\s+(enable|start|restart)\b/,
    /\bcreate_(schedule|heartbeat)\b/),
];

// D10 no es una regex sobre el texto sino una comparación de prefijos: toda ruta con raíz (~ o /home/…) que se salga del cwd de la
// sesión. Una ruta relativa es del cwd por definición.
const RUTA = /(?:^|[\s"'`(=])((?:~|\/home\/[\w.-]+)\/[\w./-]+)/g;

export function normalizar(texto: string): string {
  return texto.normalize("NFKC").trim();
}

function fueraDeAmbito(texto: string, cwd: string): string | null {
  if (!cwd) return null;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  for (const m of texto.matchAll(RUTA)) {
    const ruta = m[1];
    if (ruta === cwd || ruta.startsWith(base) || ruta === cwd.replace(/\/$/, "")) continue;
    if (/^\/(home\/[\w.-]+)?$/.test(ruta)) continue; // la casa entera no es una ruta de trabajo
    return ruta;
  }
  return null;
}

/** La primera regla que dispara, o null. D0 (vacía) va fuera del bucle: no es un patrón. */
export function evaluarReglas(sugerencia: string, cwd: string): { id: string; riesgo: Riesgo; motivo: string } | null {
  const texto = normalizar(sugerencia);
  if (texto.length < 3) return { id: "D0", riesgo: "bajo", motivo: "sugerencia vacía" };
  for (const regla of REGLAS) {
    if (regla.patrones.some((p) => p.test(texto))) return { id: regla.id, riesgo: regla.riesgo, motivo: regla.motivo };
  }
  const ruta = fueraDeAmbito(texto, cwd);
  return ruta ? { id: "D10", riesgo: "alto", motivo: `ruta fuera del ámbito: ${ruta}` } : null;
}