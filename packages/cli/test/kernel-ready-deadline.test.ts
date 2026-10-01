import { createServer } from "node:http";
import { once } from "node:events";
import type { Socket } from "node:net";
import { expect, it } from "vitest";
import { waitForKernelReady } from "../src/daemon-lifecycle.js";

it.each(["headers", "body"])("bounds a native kernel probe stalled at %s by the wait deadline", async (phase) => {
  const sockets = new Set<Socket>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    const payload = '{"kernel_state":"ready","variant":"fixture"}';
    res.setHeader("content-type", "application/json");
    if (phase === "body") {
      res.writeHead(200);
      res.flushHeaders();
      res.write(payload.slice(0, 10));
    }
    timers.push(setTimeout(() => res.end(phase === "body" ? payload.slice(10) : payload), 1000));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    const started = Date.now();
    const result = await waitForKernelReady(`http://127.0.0.1:${address.port}`, 200, 10);
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(800);
    expect(requests).toBe(1);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, "close");
  }
});

it.each(["ready", "partial_ready", "auth_blocked"])("preserves the %s kernel outcome", async (state) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ kernel_state: state, variant: "fixture" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    const result = await waitForKernelReady(`http://127.0.0.1:${address.port}`, 2000, 10);
    expect(result).toMatchObject({ ok: state !== "auth_blocked", kernelState: state, variant: "fixture" });
    expect(requests).toBe(1);
  } finally {
    server.close();
    await once(server, "close");
  }
});
