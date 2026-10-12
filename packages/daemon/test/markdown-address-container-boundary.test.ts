import assert from "node:assert/strict";
import { test } from "vitest";
import * as daemon from "../src/domain/markdown-address.js";
import * as shipped from "../assets/plugins/openrig-core/skills/loading-addressable-markdown/scripts/resolve-markdown.mjs";

for (const [reader, api] of [["daemon", daemon], ["shipped", shipped]] as const) {
 for (const marker of ["```", "~~~"]) for (const ending of ["\n", "\r\n"]) {
  for (const thematicBreak of ["- - -", "* * *", "---", "***", "___", "- \t- \t-"]) {
   test(`${reader}: thematic break ${JSON.stringify(thematicBreak)} creates no list container ${marker} ${JSON.stringify(ending)}`, () => {
    const text = ["## Actual", thematicBreak, `\t${marker}md`, "## Next", "reachable"].join(ending);
    assert.deepEqual(api.parseMarkdownSections(text).map(section=>section.headerPath), [["actual"],["next"]]);
    assert.match(api.resolveAddress(text,["next"]).text,/reachable/);
    if ("validateMarkdownAddressability" in api) assert.deepEqual(api.validateMarkdownAddressability(text),[]);
   });
  }
 }
}
