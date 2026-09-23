import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, truncateToWidth } from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { join } from "node:path";

const question = choice(
  "Should `new_prompt` be available to the agent before it finishes `current_task`, or only after it finishes? Judge intended timing, not whether the topics are related.",
  {
    steer: {
      meaning:
        "The agent must know this before finishing the current task: a correction, clarification, changed requirement, extra completion step, or request to stop an action.",
      examples: [
        "Don't delete that file; edit it instead",
        "Use SQLite, not Postgres",
        "Also run tests before you finish",
        "Stop, that command is wrong",
      ],
    },
    followUp: {
      meaning:
        "The current task should finish first; the new request is a separate task to start afterward, not a requirement for completing current work.",
      examples: [
        "After this, update the README",
        "Once you're done, review the changes",
        "Next, fix the login page",
      ],
    },
  },
);

const keyFile = () => join(getAgentDir(), "pi-jev-route.key");

function secureWindowsFile(path: string) {
  const program = `
$ErrorActionPreference = 'Stop'
$path = $env:PI_JEV_KEY_FILE
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $path
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow))
Set-Acl -LiteralPath $path -AclObject $acl
$actual = Get-Acl -LiteralPath $path
$rules = @($actual.Access)
if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or
    $rules[0].AccessControlType -ne 'Allow' -or
    $rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or
    ($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { exit 1 }
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", program],
    {
      env: { ...process.env, PI_JEV_KEY_FILE: path },
      stdio: "ignore",
      timeout: 10_000,
    },
  );
  if (result.status !== 0) throw new Error("Could not restrict Windows key file access");
}

function saveFileKey(key: string) {
  mkdirSync(getAgentDir(), { recursive: true, mode: 0o700 });
  const temp = join(getAgentDir(), `.pi-jev-route-${randomUUID()}`);
  try {
    writeFileSync(temp, "", { flag: "wx", mode: 0o600 });
    if (process.platform === "win32") secureWindowsFile(temp);
    writeFileSync(temp, key);
    renameSync(temp, keyFile());
    if (process.platform === "win32") secureWindowsFile(keyFile());
  } finally {
    rmSync(temp, { force: true });
  }
}

function saveKeychainKey(key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "security",
      ["add-generic-password", "-U", "-a", userInfo().username, "-s", "pi-jev-router", "-w"],
      { detached: true, stdio: ["pipe", "ignore", "ignore"], signal: AbortSignal.timeout(30_000) },
    );
    child.once("error", reject);
    child.stdin.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error("Keychain save failed")),
    );
    child.stdin.end(`${key}\n${key}\n`);
  });
}

export default function (pi: ExtensionAPI) {
  let client: TypeSafeClient | undefined;
  let pending = Promise.resolve();
  let taskPrompts: string[] = [];

  pi.on("agent_start", () => {
    taskPrompts = [];
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "user") return;
    const content = event.message.content;
    taskPrompts.push(
      typeof content === "string"
        ? content
        : content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
    );
  });

  pi.registerCommand("jev-login", {
    description: "Save a TypeSafe API key for future sessions",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/jev-login requires interactive Pi", "warning");
        return;
      }

      const apiKey = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
        const input = new Input();
        input.onSubmit = (value) => {
          input.setValue("");
          done(value.trim());
        };
        input.onEscape = () => done(undefined);
        return {
          get focused() {
            return input.focused;
          },
          set focused(value: boolean) {
            input.focused = value;
          },
          render(width: number) {
            const masked = "•".repeat(Math.min(input.getValue().length, Math.max(0, width - 2)));
            return [
              truncateToWidth(
                theme.fg("accent", "TypeSafe API key (Enter to save, Esc to cancel)"),
                width,
              ),
              truncateToWidth(`${theme.fg("muted", masked)}${CURSOR_MARKER}`, width),
            ];
          },
          handleInput(data: string) {
            input.handleInput(data);
            tui.requestRender();
          },
          invalidate() {},
        };
      });
      if (!apiKey) return;

      try {
        if (process.platform === "darwin") {
          try {
            await saveKeychainKey(apiKey);
            rmSync(keyFile(), { force: true });
            client = undefined;
            ctx.ui.notify("TypeSafe key saved to Keychain", "info");
            return;
          } catch {
            if (
              !(await ctx.ui.confirm(
                "Keychain unavailable",
                "Save the key in a private file instead? It will not be protected by Keychain.",
              ))
            )
              return;
          }
        }
        saveFileKey(apiKey);
        client = undefined;
        ctx.ui.notify("TypeSafe key saved to private file", "info");
      } catch {
        ctx.ui.notify("Could not save TypeSafe key", "error");
      }
    },
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" || !event.streamingBehavior) {
      return { action: "continue" };
    }
    if (!event.text.trim() || event.images?.length) {
      return pending.then(() => ({ action: "continue" as const }));
    }

    const currentTask = taskPrompts.join("\n");
    const runSignal = ctx.signal;
    const sessionId = ctx.sessionManager.getSessionId();
    if (!currentTask || !runSignal || currentTask.length > 8000 || event.text.length > 8000) {
      return pending.then(() => ({ action: "continue" as const }));
    }

    const route = pending.then(async () => {
      const restoreIfStale = () => {
        if (
          !runSignal.aborted &&
          ctx.sessionManager.getSessionId() === sessionId &&
          (ctx.isIdle() || ctx.signal === runSignal)
        )
          return false;
        ctx.ui.pasteToEditor(event.text);
        ctx.ui.notify("Task changed; prompt restored to editor", "warning");
        return true;
      };
      try {
        if (restoreIfStale()) return { action: "handled" as const };
        if (!client) {
          let apiKey = process.env.TYPESAFE_API_KEY?.trim();
          if (!apiKey) {
            try {
              if (process.platform === "win32" && existsSync(keyFile()))
                secureWindowsFile(keyFile());
              apiKey = readFileSync(keyFile(), "utf8").trim();
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
          if (!apiKey && process.platform === "darwin") {
            const result = await pi.exec("security", [
              "find-generic-password",
              "-a",
              userInfo().username,
              "-s",
              "pi-jev-router",
              "-w",
            ]);
            if (result.code === 0) apiKey = result.stdout.trim();
          }
          if (!apiKey) throw new Error("TypeSafe API key not found");
          client = new TypeSafeClient({ apiKey, timeout: 1500, retry: { maxRetries: 0 } });
        }
        const response = await client.systemOne({
          state: { current_task: currentTask, new_prompt: event.text },
          questions: { delivery: question },
        });
        const answer = response.answers.delivery;
        if (restoreIfStale()) return { action: "handled" as const };
        if (ctx.isIdle() || answer.confidence < 0.7 || answer.choice === event.streamingBehavior) {
          return { action: "continue" as const };
        }

        pi.sendUserMessage(event.text, { deliverAs: answer.choice, expandPromptTemplates: true });
        ctx.ui.notify(
          answer.choice === "steer" ? "Sending as steer" : "Sending as follow-up",
          "info",
        );
        return { action: "handled" as const };
      } catch {
        if (restoreIfStale()) return { action: "handled" as const };
        ctx.ui.notify("Jev routing unavailable; using original delivery", "warning");
        return { action: "continue" as const };
      }
    });
    pending = route.then(
      () => undefined,
      () => undefined,
    );
    return route;
  });
}
