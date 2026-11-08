// Geometry of the ✦'s state frame (no React: the test imports it as is).

/** The state frame, inside the slot the host gives the icon: `size` square, and on mobile it clips whatever sticks out (Dani 08-11:
 * «sale cortada», the frame measured size + 6). So border, padding and the red beat all fit in `size`: the star shrinks to make
 * room, and the beat shrinks the frame instead of growing it. */
export function marco(size: number, estado: string): { lado: number; borde: number; padding: number; icono: number; latido: number } {
  const borde = estado === "humano" ? 2 : 1;
  const padding = 2 - borde;
  return { lado: size, borde, padding, icono: Math.max(6, size - 2 * (borde + padding)), latido: estado === "humano" ? 0.82 : 1 };
}
