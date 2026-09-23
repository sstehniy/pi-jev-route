# Pi Jev Route

Requires Pi (`@earendil-works/pi-coding-agent`) **0.84.2 or newer**. Developed and tested on 0.87.1.

A Pi extension that sends mid-run text prompts to TypeSafe Jev to decide whether they should steer the current task or wait as a follow-up. Idle prompts go straight to Pi. Images, long prompts, uncertain answers, and API failures keep the delivery mode you selected.

## Use

```sh
pi install npm:pi-jev-route
# In Pi, run /jev-login and paste your TypeSafe API key into the masked prompt.
```

`/jev-login` saves the key to macOS Keychain without printing it in the terminal or putting it in command arguments, shell history, or a repository file. Run it again to replace the key. The new key is used immediately. If no Keychain key is saved, `TYPESAFE_API_KEY` in the environment is used instead (useful for CI). No `.env` file or shell startup-file edit is needed.

The `pi-package` keyword makes the npm release eligible for the [Pi package gallery](https://pi.dev/packages) once indexed.

Submit prompts with either Enter or Alt+Enter while Pi is working; Jev can switch their delivery mode when its answer is clear. The extension routes interactive prompts only, not RPC requests. If the active run changes before Jev replies, your prompt is returned to the editor instead of being sent into the new task. Pi still controls when steering and follow-ups are delivered. Press Escape to stop immediately; routing is not an emergency interrupt. Prompts and the active task's user instructions are sent to TypeSafe, so avoid using this extension with confidential text you cannot share with that service.

## Develop

```sh
bun install
pi -e .
bun test
bun run typecheck
```

The tests simulate TypeSafe replies without using your API key. Each live mid-run text prompt makes one Jev request. The classifier uses user instructions received during the active run; if that context is unavailable or too long, Pi retains your selected delivery mode. Pi's extension API does not confirm whether a rerouted message was enqueued: a rare asynchronous enqueue failure can still require you to resend it.
