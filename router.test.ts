import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import router from "./extensions/router";

const originalFetch = globalThis.fetch;
const originalKey = process.env.TYPESAFE_API_KEY;
const originalPath = process.env.PATH;
let loginHandler: any;
let answer = "steer";
let confidence = 0.9;
let idle = false;
let fail = false;
let requests: any[];
let sent: any[];
let notified: any[];
let keychainCalls: any[];
let authorization: string | null;
let keychainCode: number;
let activeRun: AbortController;
let sessionId: string;
let restored: string[];

beforeEach(() => {
  process.env.TYPESAFE_API_KEY = "test-key";
  answer = "steer";
  confidence = 0.9;
  idle = false;
  fail = false;
  requests = [];
  sent = [];
  notified = [];
  keychainCalls = [];
  authorization = null;
  keychainCode = 0;
  activeRun = new AbortController();
  sessionId = "test-session";
  restored = [];
  globalThis.fetch = async (_url, options) => {
    authorization = new Headers(options?.headers).get("authorization");
    requests.push(JSON.parse(String(options?.body)));
    if (fail) throw new Error("network unavailable");
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          delivery: {
            type: "choice",
            choice: answer,
            confidence,
            probabilities: { steer: 0.95, followUp: 0.05 },
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.PATH = originalPath;
  delete process.env.KEYCHAIN_PROBE;
  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
});

function setup(task = "Implement the login form", updates: string[] = []) {
  const handlers: Record<string, any> = {};
  router({
    registerCommand: (_name: string, command: any) => {
      loginHandler = command.handler;
    },
    on: (type: string, handler: any) => {
      handlers[type] = handler;
    },
    sendUserMessage: (...args: any[]) => sent.push(args),
    exec: async (...args: any[]) => {
      keychainCalls.push(args);
      return {
        code: keychainCode,
        stdout: keychainCode === 0 ? "keychain-test-key\n" : "",
        stderr: "",
      };
    },
  } as any);
  const ctx = {
    sessionManager: { getSessionId: () => sessionId },
    get signal() {
      return activeRun.signal;
    },
    isIdle: () => idle,
    ui: {
      notify: (...args: any[]) => notified.push(args),
      pasteToEditor: (text: string) => restored.push(text),
    },
  };
  handlers.agent_start({}, ctx);
  for (const text of [task, ...updates]) {
    handlers.message_end({ message: { role: "user", content: [{ type: "text", text }] } }, ctx);
  }
  return (text: string, streamingBehavior: "steer" | "followUp" = "followUp", extra = {}) =>
    handlers.input(
      { type: "input", text, streamingBehavior, source: "interactive", ...extra },
      ctx,
    );
}

test("/jev-login masks the key and saves it through stdin, not command arguments", async () => {
  if (process.platform !== "darwin") return;
  setup();
  const dir = mkdtempSync(join(tmpdir(), "pi-jev-login-"));
  const file = join(dir, "captured");
  const security = join(dir, "security");
  writeFileSync(
    security,
    "#!/usr/bin/python3\nimport os, sys\nopen(os.environ['KEYCHAIN_PROBE'], 'w').write('|'.join(sys.argv[1:]) + '\\n' + sys.stdin.read())\n",
  );
  chmodSync(security, 0o700);
  process.env.PATH = `${dir}:${originalPath}`;
  process.env.KEYCHAIN_PROBE = file;
  try {
    await loginHandler("", {
      mode: "tui",
      ui: {
        notify: (...args: any[]) => notified.push(args),
        custom: async (factory: any) =>
          new Promise((done) => {
            const component = factory(
              { requestRender() {} },
              { fg: (_color: string, text: string) => text },
              {},
              done,
            );
            component.handleInput("dummy-private-key");
            expect(component.render(80).join(" ")).not.toContain("dummy-private-key");
            component.handleInput("\n");
          }),
      },
    });
    const saved = readFileSync(file, "utf8");
    expect(saved.split("\n")[0]).not.toContain("dummy-private-key");
    expect(saved).toEndWith("dummy-private-key\ndummy-private-key\n");
    expect(notified.at(-1)?.[1]).toBe("info");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reroutes a correction to steer with its text intact", async () => {
  const input = setup();
  expect(await input("Use passkeys, not passwords")).toEqual({ action: "handled" });
  expect(sent).toEqual([
    ["Use passkeys, not passwords", { deliverAs: "steer", expandPromptTemplates: true }],
  ]);
  expect(requests[0].state).toEqual({
    current_task: "Implement the login form",
    new_prompt: "Use passkeys, not passwords",
  });
  expect(requests[0].questions.delivery.criteria).toHaveProperty("followUp");
  expect(await input("Use passkeys, not passwords", "steer", { source: "extension" })).toEqual({
    action: "continue",
  });
  expect(requests).toHaveLength(1);
});

test("loads the key from macOS Keychain when no environment key exists", async () => {
  if (process.platform !== "darwin") return;
  delete process.env.TYPESAFE_API_KEY;
  const input = setup();
  expect(await input("Use passkeys")).toEqual({ action: "handled" });
  expect(await input("Use passkeys again")).toEqual({ action: "handled" });
  expect(keychainCalls).toEqual([
    ["security", ["find-generic-password", "-a", process.env.USER, "-s", "pi-jev-router", "-w"]],
  ]);
  expect(authorization).toBe("Bearer keychain-test-key");
});

test("uses the environment key when Keychain has no key", async () => {
  keychainCode = 44;
  expect(await setup()("Use passkeys")).toEqual({ action: "handled" });
  expect(authorization).toBe("Bearer test-key");
});

test("keeps the original delivery when the key is missing", async () => {
  delete process.env.TYPESAFE_API_KEY;
  keychainCode = 44;
  expect(await setup()("Use passkeys")).toEqual({ action: "continue" });
  expect(sent).toHaveLength(0);
  expect(requests).toHaveLength(0);
});

test("keeps the original task when classifying after a steering correction", async () => {
  await setup("Implement the login form", ["Use passkeys instead of passwords"])("Also run tests");
  expect(requests[0].state.current_task).toBe(
    "Implement the login form\nUse passkeys instead of passwords",
  );
});

test("restores an in-flight prompt after abort and restart", async () => {
  const input = setup();
  const original = globalThis.fetch;
  let release: () => void = () => {};
  let startedFetch: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    startedFetch = resolve;
  });
  globalThis.fetch = async (url, options) => {
    startedFetch();
    await waiting;
    return original(url, options);
  };
  const submitted = input("Use passkeys");
  await started;
  activeRun.abort();
  activeRun = new AbortController();
  release();
  expect(await submitted).toEqual({ action: "handled" });
  expect(restored).toEqual(["Use passkeys"]);
  expect(sent).toHaveLength(0);
});

test("restores a prompt when Jev fails after abort and restart", async () => {
  const input = setup();
  const original = globalThis.fetch;
  let release: () => void = () => {};
  let startedFetch: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    startedFetch = resolve;
  });
  globalThis.fetch = async (url, options) => {
    startedFetch();
    await waiting;
    return original(url, options);
  };
  const submitted = input("Use passkeys");
  await started;
  activeRun.abort();
  activeRun = new AbortController();
  fail = true;
  release();
  expect(await submitted).toEqual({ action: "handled" });
  expect(restored).toEqual(["Use passkeys"]);
  expect(sent).toHaveLength(0);
});

test("reroutes later work as a follow-up", async () => {
  answer = "followUp";
  expect(await setup()("After this, update the README", "steer")).toEqual({ action: "handled" });
  expect(sent[0][1].deliverAs).toBe("followUp");
});

test("preserves the original mode when the answer is uncertain or unchanged", async () => {
  confidence = 0.51;
  const input = setup();
  expect(await input("Also run tests")).toEqual({ action: "continue" });
  confidence = 0.9;
  expect(await input("Use passkeys", "steer")).toEqual({ action: "continue" });
  expect(sent).toHaveLength(0);
});

test("does not steer a run that ended while Jev was answering", async () => {
  const input = setup();
  globalThis.fetch = async () => {
    idle = true;
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          delivery: {
            type: "choice",
            choice: "steer",
            confidence: 0.9,
            probabilities: { steer: 0.95, followUp: 0.05 },
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  expect(await input("Use passkeys")).toEqual({ action: "continue" });
  expect(sent).toHaveLength(0);
});

test("routes rapid submissions in the order they were entered", async () => {
  const input = setup();
  let releaseFirst: () => void = () => {};
  const firstRequest = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (JSON.parse(String(options?.body)).state.new_prompt === "First correction")
      await firstRequest;
    return original(url, options);
  };
  const first = input("First correction");
  const second = input("Second correction");
  releaseFirst();
  await Promise.all([first, second]);
  expect(sent.map(([text]) => text)).toEqual(["First correction", "Second correction"]);
});

test("keeps original delivery for images, missing context, and API errors", async () => {
  const input = setup();
  expect(await input("Look at this", "followUp", { images: [{ type: "image" }] })).toEqual({
    action: "continue",
  });
  expect(await setup("")("Change this")).toEqual({ action: "continue" });
  fail = true;
  expect(await input("Use passkeys")).toEqual({ action: "continue" });
  expect(sent).toHaveLength(0);
  expect(notified.at(-1)?.[1]).toBe("warning");
});
