import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tamizar } from "../service/tamiz.ts";
import { LEGITIMAS } from "./rules-fixtures.ts";

// El tamiz se mira antes que el modelo; lo que no puede es comerse trabajo normal. Se prueba con las 20 legítimas ya
// medidas: si una dispara, la puerta cierra una continuación buena.
describe("el tamiz léxico", () => {
  it("ve dinero cuando se mueven credenciales", () => {
    assert.deepEqual(tamizar("rota el token de gh de pocharlies y guárdalo en 1Password").riesgo, "dinero");
    assert.equal(tamizar("revoca la clave vieja del servicio").patron, "credenciales");
  });

  it("no ve credenciales en hablar de ellas", () => {
    assert.equal(tamizar("revisa el token de lectura del servidor 1password").riesgo, null);
    assert.equal(tamizar("comprueba que el secreto existe en el ClusterSecretStore").riesgo, null);
  });

  it("ve dinero en el importe y en publicar fuera", () => {
    assert.equal(tamizar("paga la factura del proveedor").riesgo, "dinero");
    assert.equal(tamizar("publica el anuncio en redes").patron, "publicar fuera");
  });

  it("ve lo irreversible aunque no nombre el mando", () => {
    assert.equal(tamizar("ese cambio es irreversible, no se deshace").riesgo, "alto");
  });

  it("ninguna de las 20 legítimas trae riesgo", () => {
    const disparan = LEGITIMAS.map((t) => [t, tamizar(t).riesgo]).filter(([, r]) => r !== null);
    assert.deepEqual(disparan, []);   // medido, no argumentado: hoy 0 de 20
  });

  it("la prosa deja marca y no veta", () => {
    const t = tamizar("Por supuesto, aquí tienes el PR. No dudes en pedirme más.");
    assert.equal(t.riesgo, null);
    assert.deepEqual(t.marcas, ["marca=prosa-par1", "marca=prosa-par2"]);
  });
});