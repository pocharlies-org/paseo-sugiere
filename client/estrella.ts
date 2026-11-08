// When the ✦ spins (no React: the test imports it as is).

/** The star spins while something is under way: a suggestion being generated, and the autopilot the whole time it is on
 * («autopilot» working or waiting, «pensando» asking the service). Red («humano») beats instead. */
export const gira = (estado: string): boolean => estado === "generando" || estado === "pensando" || estado === "autopilot";
