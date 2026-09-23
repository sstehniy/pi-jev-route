import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, truncateToWidth } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { userInfo } from "node:os";

const question = choice(
  "Should `new_prompt` be available to the agent before it finishes `current_task`, or only after it finishes? Judge intended timing, not whether the topics are related.",
  {
    steer: {
      meaning: "The agent must know this before finishing the current task: a correction, clarification, changed requirement, extra completion step, or request to stop an action.",
      examples: ["Don't delete that file; edit it instead", "Use SQLite, not Postgres", "Also run tests before you finish", "Stop, that command is wrong"],
    },
    followUp: {
      meaning: "The current task should finish first; the new request is a separate task to start afterward, not a requirement for completing current work.",
      examples: ["After this, update the README", "Once you're done, review the changes", "Next, fix the login page"],
    },
  },
);

export default function (pi: ExtensionAPI) {
  let client: TypeSafeClient | undefined;
  let pending = Promise.resolve();
  let taskPrompts: string[] = [];

  pi.on("agent_start", () => { taskPrompts = []; });
  pi.on("message_end", (event) => {
    if (event.message.role !== "user") return;
    const content = event.message.content;
    taskPrompts.push(typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
  });

  pi.registerCommand("jev-login", {
    description: "Save a TypeSafe API key in macOS Keychain",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || process.platform !== "darwin") {
        ctx.ui.notify("/jev-login requires interactive Pi on macOS", "warning");
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
          get focused() { return input.focused; },
          set focused(value: boolean) { input.focused = value; },
          render(width: number) {
            const masked = "•".repeat(Math.min(input.getValue().length, Math.max(0, width - 2)));
            return [
              truncateToWidth(theme.fg("accent", "TypeSafe API key (Enter to save, Esc to cancel)"), width),
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
        await new Promise<void>((resolve, reject) => {
          const child = spawn("security", ["add-generic-password", "-U", "-a", userInfo().username, "-s", "pi-jev-router", "-w"], {
            stdio: ["pipe", "ignore", "ignore"],
          });
          child.once("error", reject);
          child.stdin.once("error", reject);
          child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Keychain save failed")));
          child.stdin.end(`${apiKey}\n${apiKey}\n`);
        });
        client = undefined;
        ctx.ui.notify("TypeSafe key saved to Keychain", "info");
      } catch {
        ctx.ui.notify("Could not save TypeSafe key to Keychain", "error");
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
        if (!runSignal.aborted && ctx.sessionManager.getSessionId() === sessionId && (ctx.isIdle() || ctx.signal === runSignal)) return false;
        ctx.ui.pasteToEditor(event.text);
        ctx.ui.notify("Task changed; prompt restored to editor", "warning");
        return true;
      };
      try {
        if (restoreIfStale()) return { action: "handled" as const };
        if (!client) {
          let apiKey: string | undefined;
          if (process.platform === "darwin") {
            const result = await pi.exec("security", ["find-generic-password", "-a", userInfo().username, "-s", "pi-jev-router", "-w"]);
            if (result.code === 0) apiKey = result.stdout.trim();
          }
          apiKey ||= process.env.TYPESAFE_API_KEY?.trim();
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
        ctx.ui.notify(answer.choice === "steer" ? "Sending as steer" : "Sending as follow-up", "info");
        return { action: "handled" as const };
      } catch {
        if (restoreIfStale()) return { action: "handled" as const };
        ctx.ui.notify("Jev routing unavailable; using original delivery", "warning");
        return { action: "continue" as const };
      }
    });
    pending = route.then(() => undefined, () => undefined);
    return route;
  });
}
