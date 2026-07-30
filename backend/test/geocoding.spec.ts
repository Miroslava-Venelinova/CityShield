// Nominatim query scoping.
//
// The sources are Varna-*province* scoped, not Varna-city scoped: vik publishes
// outages in Долни чифлик, Аврен and Тополи. Every lookup used to be anchored
// to "Варна" regardless, so a village street was searched for in the city — and
// since Bulgarian settlements reuse street names freely (ул. Камчия and
// ул. Плевен exist both in Варна and elsewhere), Nominatim answered with the
// wrong one rather than nothing. Caught by the 30.07.2026 review's
// Долни чифлик alert.

import { describe, expect, it } from "vitest";
import { buildGeocodeQuery } from "../src/core/geocoding";

describe("buildGeocodeQuery", () => {
  it("anchors to Варна by default, as every district-level lookup wants", () => {
    expect(buildGeocodeQuery("Чайка")).toBe("Чайка, Варна, България");
    expect(buildGeocodeQuery("ул. Дубровник")).toBe("ул. Дубровник, Варна, България");
  });

  it("does not repeat an anchor the name already carries", () => {
    expect(buildGeocodeQuery("Варна")).toBe("Варна, България");
    // Case-insensitively, because the sources capitalise inconsistently.
    expect(buildGeocodeQuery("ВАРНА")).toBe("ВАРНА, България");
    expect(buildGeocodeQuery("Долни чифлик", "Долни чифлик")).toBe("Долни чифлик, България");
  });

  it("scopes a street to the settlement it was named under", () => {
    // The whole point: this is a Долни чифлик street, and ул. Камчия also
    // exists in Варна. Anchoring to the city returned the city's one.
    expect(buildGeocodeQuery("Камчия", "Долни чифлик")).toBe("Камчия, Долни чифлик, България");
  });

  it("drops the scope entirely when given an empty anchor", () => {
    expect(buildGeocodeQuery("Аврен", "")).toBe("Аврен, България");
    expect(buildGeocodeQuery("Аврен", "   ")).toBe("Аврен, България");
  });
});
