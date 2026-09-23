# Pi Jev Route

Routes mid-run prompts in [Pi](https://github.com/earendil-works/pi) with TypeSafe Jev. Requires Pi 0.84.2 or newer.

## Install

```sh
pi install npm:pi-jev-route
```

Run `/jev-login` in Pi and enter your TypeSafe API key in the masked prompt. On macOS, the key goes into Keychain. If Keychain is unavailable, Pi asks before saving it to a private file instead. On Linux and Windows, it saves to `<agent-dir>/pi-jev-route.key` (normally `~/.pi/agent/pi-jev-route.key`). Keep your agent directory private, especially if you changed `PI_CODING_AGENT_DIR`. Run `/jev-login` again to replace the key.

For non-interactive use, set `TYPESAFE_API_KEY` in the process environment instead. You do not need a `.env` file or a shell startup-file edit.

## Behavior

While Pi is working, Jev can change a text prompt between steering the current task and waiting as a follow-up. Uncertain answers, images, and service errors keep the delivery mode you selected. If the active run changes while Jev answers, your prompt returns to the editor. Routing does not act as an emergency stop.

The current task and the new prompt are sent to TypeSafe for this decision. Do not use the extension with text you cannot share with TypeSafe.

## Develop

```sh
bun install
bun test
bun run typecheck
bun run lint
bun run format:check
```
