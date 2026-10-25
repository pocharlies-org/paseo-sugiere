import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { suggestSettings } from "../shared/settings.ts";

// A fresh install has no stored document: the host parses `{}` and must answer `ready` with the defaults, or the first
// save from the settings screen always conflicts («El host no aceptó el cambio»).
describe("the settings document", () => {
  it("parses an empty document into the defaults", () => {
    assert.deepEqual(suggestSettings.schema.parse({}), { enabled: true, auto: false, quietSeconds: 60 }); // auto off: no automatic calls (Dani 25-10)
  });
  it("takes 0 seconds and refuses anything over 600", () => {
    assert.equal(suggestSettings.schema.parse({ enabled: true, quietSeconds: 0 }).quietSeconds, 0);
    assert.throws(() => suggestSettings.schema.parse({ enabled: true, quietSeconds: 601 }));
  });
});
