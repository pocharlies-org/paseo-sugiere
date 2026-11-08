// Geometry of the ✦'s state ring (no React: the test imports it as is).

/** The box the host gives every plugin icon. It passes `size` 14 in the composer, but draws the icon in this box.
 * shortcut: the value is copied from Paseo 0.15 (`icon: {width: 16, height: 16, overflow: "hidden"}` in its button styles); if the
 * host widens the box, change it here. */
export const CAJA = 16;

/** The state ring fills the whole box: Dani 08-11 found the ring sized to `size` too small («ese círculo es pequeño»), and
 * anything larger than the box is clipped («sale cortada»). The red beat shrinks the ring instead of growing it. */
export function marco(estado: string): { lado: number; borde: number; icono: number; latido: number } {
  const borde = estado === "humano" ? 2 : 1.5;
  return { lado: CAJA, borde, icono: CAJA - 2 * borde - 1, latido: estado === "humano" ? 0.82 : 1 };
}
