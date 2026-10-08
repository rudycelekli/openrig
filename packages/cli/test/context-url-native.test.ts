import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Baseline qualification: real compiled CLI, private daemon/SQLite, and owned
// HTTP resources. No lifecycle, filesystem, fetch, or library mocks are used.
describe("context URL install through the compiled CLI and owned daemon", () => {
  let root: string;
  let library: string;
  let env: NodeJS.ProcessEnv;
  let daemonPid: number | undefined;
  let startAttempted = false;
  let teardownValidated = false;
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");

  async function run(args: string[], timeout = 10_000) {
    const options = { env, cwd: root, timeout, maxBuffer: 2 * 1024 * 1024 };
    try {
      const result = await promisify(execFile)(process.execPath, [cli, ...args], options);
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const result = error as { code?: unknown; signal?: unknown; stdout?: string; stderr?: string };
      // A timeout, signal, or launcher failure is not evidence of an admitted
      // install refusal. Only actual numeric CLI exits are captured below.
      if (typeof result.code !== "number" || result.signal) throw error;
      return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    }
  }

  async function freePort() {
    const server = net.createServer();
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No private daemon port");
    await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
    return address.port;
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "context-url-native-"));
    library = join(root, "library");
    for (const dir of ["home", "state", "tmp", "codex", "claude", "xdg", "library"]) {
      mkdirSync(join(root, dir));
    }
    // Replace the child environment wholesale. No ambient daemon endpoint,
    // provider credentials, configuration, tmux socket, or session is inherited.
    env = {
      PATH: process.env.PATH,
      HOME: join(root, "home"), TMPDIR: join(root, "tmp"), TMUX_TMPDIR: join(root, "tmp"),
      CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"),
      XDG_CONFIG_HOME: join(root, "xdg"), XDG_CACHE_HOME: join(root, "xdg"),
      OPENRIG_HOME: join(root, "state"), OPENRIG_CONTEXT_ROOT: library,
      OPENRIG_TRANSCRIPTS_PATH: join(root, "transcripts"), CI: "true", TERM: "xterm-256color",
    };
    const port = await freePort();
    startAttempted = true;
    const started = await run(["daemon", "start", "--host", "127.0.0.1", "--port", String(port),
      "--db", join(root, "state", "fixture.sqlite"), "--no-kernel"]);
    expect(started.code, started.stderr || started.stdout).toBe(0);
    const state = JSON.parse(readFileSync(join(root, "state", "daemon.json"), "utf8"));
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5_000) });
    expect(response.ok).toBe(true);
    const health = await response.json() as { pid: number };
    expect(Number.isInteger(health.pid) && health.pid > 0).toBe(true);
    expect(health.pid).toBe(state.pid);
    daemonPid = health.pid;
    expect(state.port).toBe(port);
    expect(state.db).toBe(join(root, "state", "fixture.sqlite"));
    expect(readFileSync(state.db).subarray(0, 16).toString()).toBe("SQLite format 3\u0000");
    env.OPENRIG_URL = `http://127.0.0.1:${port}`;
    console.info("context-native-daemon", { pid: daemonPid, port, ownDatabase: true });
  });

  afterAll(async () => {
    if (!root) return;
    try {
      let stoppedSuccessfully = false;
      if (startAttempted) {
        // The product stop deadline is 12 seconds; let that native judgment
        // finish instead of interrupting it at the ordinary command's bound.
        const stopped = await run(["daemon", "stop"], 15_000);
        expect(stopped.code, stopped.stderr || stopped.stdout).toBe(0);
        stoppedSuccessfully = true;
      }
      if (daemonPid !== undefined) {
        let absent = false;
        const deadline = Date.now() + 4_000;
        do {
          try { process.kill(daemonPid, 0); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            absent = true;
            break;
          }
          await new Promise((accept) => setTimeout(accept, 50));
        } while (Date.now() < deadline);
        expect(absent, "owned daemon must exit before fixture removal").toBe(true);
        teardownValidated = stoppedSuccessfully && absent;
        console.info("context-native-daemon-cleanup", { pid: daemonPid, absent });
      } else if (!startAttempted) {
        // No daemon command was attempted: no owned lifecycle can be live.
        teardownValidated = true;
      }
    } finally {
      // If teardown refuses, retain the owned state/logs rather than unlinking
      // the live daemon's configuration or removing another instance's files.
      if (teardownValidated && !existsSync(join(root, "state", "daemon.json")) &&
          !existsSync(join(root, "state", "daemon-start.lock"))) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  async function serve(files: Record<string, string>, redirect = false) {
    const requests: string[] = [];
    const server = http.createServer((request, response) => {
      const raw = request.url ?? "/";
      requests.push(raw);
      const pathname = decodeURIComponent(new URL(raw, "http://127.0.0.1").pathname);
      if (redirect && pathname === "/old/manifest.yaml") {
        response.writeHead(302, { location: "/pack/manifest.yaml" });
        response.end();
        return;
      }
      const text = files[pathname];
      response.writeHead(text === undefined ? 404 : 200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(text ?? "owned fixture not found");
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No owned HTTP port");
    return {
      url: `http://127.0.0.1:${address.port}${redirect ? "/old" : "/pack"}/manifest.yaml`, requests,
      close: () => new Promise<void>((accept, reject) => {
        server.close((error) => error ? reject(error) : accept());
        server.closeAllConnections();
      }),
    };
  }

  const manifest = (name: string, filename: string) =>
    `name: ${JSON.stringify(name)}\nversion: "1"\ntaxonomy: world\nfiles:\n  - path: ${JSON.stringify(filename)}\n    role: instruction\n`;

  async function visible(target: string) {
    const listed = await run(["context", "list", "--json"]);
    expect(listed.code, listed.stderr).toBe(0);
    const entries = JSON.parse(listed.stdout) as Array<{ sourcePath: string; relativePath: string }>;
    expect(entries.some((entry) => resolve(entry.sourcePath) === target)).toBe(true);
  }

  function record(name: string, result: Awaited<ReturnType<typeof run>>, requests: string[]) {
    console.info("context-native-result", JSON.stringify({ name, code: result.code,
      stdout: result.stdout.replaceAll(root, "<fixture>"), stderr: result.stderr.replaceAll(root, "<fixture>"), requests }));
    expect(readdirSync(library).filter((name) => name.startsWith(".tmp-add-"))).toEqual([]);
  }

  it.each([
    { name: "plain", declared: "plain-pack", installed: "plain-pack", parent: false, local: false },
    { name: "missing namespace override", declared: "override-pack", installed: "new-group/override-pack", parent: false, local: false },
    { name: "missing namespace manifest", declared: "declared-group/declared-pack", installed: "declared-group/declared-pack", parent: false, local: false },
    { name: "existing namespace", declared: "existing-pack", installed: "existing-group/existing-pack", parent: true, local: false },
    { name: "local namespace", declared: "local-pack", installed: "local-group/local-pack", parent: false, local: true },
  ])("installs $name with actual daemon indexing", async ({ name, declared, installed, parent, local }) => {
    const body = `owned ${name} bytes\n`;
    if (parent) mkdirSync(join(library, "existing-group"));
    const server = await serve({ "/pack/manifest.yaml": manifest(declared, "notes.md"), "/pack/notes.md": body });
    try {
      let source = server.url;
      if (local) {
        source = join(root, "local-source"); mkdirSync(source);
        writeFileSync(join(source, "manifest.yaml"), manifest(declared, "notes.md"));
        writeFileSync(join(source, "notes.md"), body);
      }
      const result = await run(["context", "add", source, ...(declared === installed ? [] : ["--name", installed]), "--json"]);
      record(name, result, server.requests);
      expect(result.code, result.stderr).toBe(0);
      const target = join(library, installed);
      expect(JSON.parse(result.stdout).installedAt).toBe(target);
      expect(readFileSync(join(target, "notes.md"), "utf8")).toBe(body);
      await visible(target);
    } finally { await server.close(); }
  });

  it.each(["notes#part.md", "notes?part.md", "notes%20literal.md", "notes ü.md"])(
    "retains the literal filename and bytes for %s", async (filename) => {
      const name = `file-${["notes#part.md", "notes?part.md", "notes%20literal.md", "notes ü.md"].indexOf(filename)}`;
      const body = `authored literal ${filename}\n`;
      const server = await serve({ "/pack/manifest.yaml": manifest(name, filename), [`/pack/${filename}`]: body,
        "/pack/notes literal.md": "different owned resource\n" });
      try {
        const result = await run(["context", "add", server.url, "--json"]);
        record(filename, result, server.requests);
        const target = join(library, name);
        const actual = existsSync(join(target, filename)) ? readFileSync(join(target, filename), "utf8") : null;
        console.info("context-native-bytes", { filename, expected: digest(body),
          actual: actual === null ? null : digest(actual), fileExists: actual !== null });
        expect(result.code, result.stderr).toBe(0);
        expect(actual).toBe(body);
        expect(server.requests).toContain(`/pack/${encodeURIComponent(filename)}`);
        await visible(target);
      } finally { await server.close(); }
    });

  it("resolves an ordinary file from the actual redirected manifest", async () => {
    const server = await serve({ "/pack/manifest.yaml": manifest("redirect-pack", "notes.md"), "/pack/notes.md": "redirected bytes\n" }, true);
    try {
      const result = await run(["context", "add", server.url, "--json"]);
      record("redirect", result, server.requests);
      expect(result.code, result.stderr).toBe(0);
      expect(server.requests).toEqual(["/old/manifest.yaml", "/pack/manifest.yaml", "/pack/notes.md"]);
      expect(readFileSync(join(library, "redirect-pack", "notes.md"), "utf8")).toBe("redirected bytes\n");
      await visible(join(library, "redirect-pack"));
    } finally { await server.close(); }
  });

  it.each([
    { name: "missing-file-pack", filename: "missing.md", diagnostic: /HTTP 404/, fileRequested: true },
    { name: "escaping-file-pack", filename: "../escape.md", diagnostic: /must be a relative path/, fileRequested: false },
    { name: "absolute-url-pack", filename: "http://127.0.0.1:1/secret.md", diagnostic: /outside the pack directory/, fileRequested: false },
  ])("preserves the existing refusal and atomic staging for $name", async ({ name, filename, diagnostic, fileRequested }) => {
    const server = await serve({ "/pack/manifest.yaml": manifest(name, filename) });
    try {
      const result = await run(["context", "add", server.url, "--json"]);
      record(name, result, server.requests);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(diagnostic);
      expect(existsSync(join(library, name))).toBe(false);
      expect(server.requests.length).toBe(fileRequested ? 2 : 1);
    } finally { await server.close(); }
  });
});
