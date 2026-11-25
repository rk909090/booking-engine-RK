import { describe, expect, it } from "vitest";
import { negotiateLocale } from "./negotiate";

describe("negotiateLocale", () => {
  it("falls back to English without a header", () => {
    expect(negotiateLocale(null)).toBe("en");
    expect(negotiateLocale("")).toBe("en");
  });

  it("matches on the primary language tag", () => {
    expect(negotiateLocale("id-ID,id;q=0.9,en;q=0.8")).toBe("id");
    expect(negotiateLocale("en-AU")).toBe("en");
  });

  it("respects quality values over order", () => {
    expect(negotiateLocale("en;q=0.5,id;q=0.9")).toBe("id");
  });

  it("maps the legacy 'in' tag to Indonesian", () => {
    expect(negotiateLocale("in-ID")).toBe("id");
  });

  it("skips unsupported and q=0 languages", () => {
    expect(negotiateLocale("fr-FR,de;q=0.9,id;q=0.5")).toBe("id");
    expect(negotiateLocale("id;q=0,ja")).toBe("en");
  });
});
