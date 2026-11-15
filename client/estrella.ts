// When the ✦ spins (no React: the test imports it as is).

/** The star spins while something is under way: a suggestion being generated, and an autopilot pair the whole time the auditor
 * pilots it («autopilot» = activa/esperando, «pensando» = the auditor deciding). Red («humano») beats instead; «degradada» and
 * «entregada» are steady. */
export const gira = (estado: string): boolean => estado === "generando" || estado === "pensando" || estado === "autopilot";
