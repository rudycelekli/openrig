import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("accepts IPv6 same-host browser requests without changing terminal authorization", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("./fixtures/ipv6-origin.mjs", import.meta.url)),
  ], { env: { ...process.env, OPENRIG_ALLOWED_ORIGINS: "" }, encoding: "utf8", timeout: 10000 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual({ scenarios: ["same-ipv6", "same-ipv6-no-port",
    "different-ipv6", "same-dns", "same-ipv4", "loopback"], bearerRequired: true, unauthenticatedRemoteRefused: true });
});
