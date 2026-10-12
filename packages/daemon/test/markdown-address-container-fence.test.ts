import assert from "node:assert/strict";
import { test } from "vitest";
import * as daemon from "../src/domain/markdown-address.js";
import * as shipped from "../assets/plugins/openrig-core/skills/loading-addressable-markdown/scripts/resolve-markdown.mjs";

for (const [reader, api] of [["daemon", daemon], ["shipped", shipped]] as const) {
  for (const marker of ["```", "~~~"]) {
    for (const ending of ["\n", "\r\n"]) {
      for (const [label, openerIndent, closerIndent, example] of [
        ["tab opener and closer", "\t", "\t", "Example"],
        ["space opener and tab closer", "  ", "\t", "Example"],
        ["tab opener and space closer", "\t", "  ", "Example"],
        ["sample Next is not a duplicate", "\t", "\t", "Next"],
      ]) {
        test(`${reader}: list ${label} ${marker} (${JSON.stringify(ending)})`, () => {
          const text = ["## Actual", "- item", `${openerIndent}${marker}md`, `  ## ${example}`, "  ### Child", `${closerIndent}${marker}`, "", "## Next", "reachable"].join(ending);
          assert.deepEqual(api.parseMarkdownSections(text).map(section => section.headerPath), [["actual"], ["next"]]);
          assert.match(api.resolveAddress(text, ["next"]).text, /reachable/);
          assert.throws(() => api.resolveAddress(text, [example.toLowerCase(), "child"]));
          if ("validateMarkdownAddressability" in api) assert.deepEqual(api.validateMarkdownAddressability(text), []);
        });
      }
      for (const position of ["opener", "closer"]) {
        test(`${reader}: leading lone CR ${position} ${marker} (${JSON.stringify(ending)})`, () => {
          const text = ["## Actual", `${position === "opener" ? "\r" : ""}${marker}md`, "## Example", `${position === "closer" ? "\r" : ""}${marker}`, "## Next", "reachable"].join(ending);
          assert.deepEqual(api.parseMarkdownSections(text).map(section => section.headerPath), [["actual"], ["next"]]);
          assert.throws(() => api.resolveAddress(text, ["example"]));
          assert.match(api.resolveAddress(text, ["next"]).text, /reachable/);
          if ("validateMarkdownAddressability" in api) assert.deepEqual(api.validateMarkdownAddressability(text), []);
        });
      }
      for (const [label, prefix] of [["form feed", "\f"], ["vertical tab", "\v"], ["NBSP", "\u00a0"], ["em space", "\u2003"]]) {
        test(`${reader}: top-level ${label} ${marker} remains non-fence (${JSON.stringify(ending)})`, () => {
          const text = ["## Actual", `${prefix}${marker}md`, "body", "## Next", "reachable"].join(ending);
          assert.deepEqual(api.parseMarkdownSections(text).map(section => section.headerPath), [["actual"], ["next"]]);
          assert.match(api.resolveAddress(text, ["next"]).text, /reachable/);
          if ("validateMarkdownAddressability" in api) assert.deepEqual(api.validateMarkdownAddressability(text), []);
        });
      }
    }
  }
}
