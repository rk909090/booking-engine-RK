import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildXlsx, columnName } from "./xlsx";

describe("xlsx writer", () => {
  it("names columns like Excel", () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });

  it("writes a valid workbook: numbers as numbers, text escaped, bold frozen header, unique sheet names", () => {
    const bytes = buildXlsx([
      { name: "Villas", rows: [["villa", "revenue"], ["UBD-RVP-01 <A&B>", 19_500_000], ["empty", null]] },
      { name: "Villas", rows: [["x"]] },
      { name: "Bad/name:*?", rows: [] },
    ]);
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(
      ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml"].sort(),
    );
    const workbook = strFromU8(files["xl/workbook.xml"]);
    expect(workbook).toContain('name="Villas"');
    expect(workbook).toContain('name="Villas 2"');
    expect(workbook).toContain('name="Bad name"');
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]);
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">villa</t></is></c>');
    expect(sheet).toContain('<c r="B2"><v>19500000</v></c>');
    expect(sheet).toContain("UBD-RVP-01 &lt;A&amp;B&gt;");
    expect(sheet).toContain('state="frozen"');
    expect(sheet).not.toContain('r="B3"');
  });
});
