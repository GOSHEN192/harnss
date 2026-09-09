import { describe, expect, it } from "vitest";
import { TRANSLATIONS, translate } from "./translations";

describe("explicit translations", () => {
  it("translates known UI labels only when Chinese is selected", () => {
    expect(translate("Settings", "zh")).toBe("设置");
    expect(translate("Settings", "en")).toBe("Settings");
  });

  it("leaves user-generated and unknown text unchanged", () => {
    const userText = "A project title from the user";
    expect(translate(userText, "zh")).toBe(userText);
    expect(translate("not in the catalog", "zh")).toBe("not in the catalog");
  });

  it("contains no reverse or DOM-observer translation state", () => {
    expect(Object.keys(TRANSLATIONS).length).toBeGreaterThan(100);
    expect(translate("设置", "en")).toBe("设置");
  });
});
