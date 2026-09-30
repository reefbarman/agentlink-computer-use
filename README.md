# AgentLink Computer Use

**Give AgentLink eyes and hands on your Mac.**

A local [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for discovering applications, inspecting accessible controls, capturing screens, and performing bounded mouse and keyboard actions. Built for [AgentLink](https://github.com/reefbarman/agentlink), with a TypeScript MCP interface and a Swift native helper.

![macOS 14+](https://img.shields.io/badge/macOS-14%2B-222222?logo=apple)
![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)
![Swift 6](https://img.shields.io/badge/Swift-6-F05138?logo=swift&logoColor=white)

> **This controls your real desktop.** Start with read-only requests, review tool approvals, and keep the Computer Use menu within reach. Screenshots and tool results can be sent to the model provider configured in AgentLink, even though the server runs locally.

[Install](#install) · [Connect to AgentLink](#connect-to-agentlink) · [Try-it prompts](#try-it-prompts) · [Safety](#safety-and-privacy) · [Troubleshooting](#troubleshooting)

## What it can do

| Capability                                                                | Tools                                                     |
| ------------------------------------------------------------------------- | --------------------------------------------------------- |
| Check permissions, control state, and local model readiness               | `computer_status`                                         |
| Discover displays, running applications, and windows                      | `display_list`, `application_list`, `window_list`         |
| Bring an application or window to the foreground                          | `application_activate`, `window_focus`                    |
| Capture a display, window, or region with coordinate mapping              | `screen_capture`                                          |
| Find accessible controls, act on them, fill fields, and verify conditions | `ui_query`, `ui_act`, `ui_fill`, `ui_wait`, `ui_workflow` |
| Move, click, drag, scroll, type, and send shortcuts                       | Mouse and keyboard tools                                  |
| Run a known input sequence or release held input                          | `input_batch`, `input_release_all`                        |

Accessible controls are the preferred route: semantic actions re-resolve their targets and check the conditions supplied with the action. For custom-drawn or visual-only UI, the agent can use screenshots and physical input instead. Semantic actions do not silently fall back to clicking guessed coordinates.

## Requirements

- **macOS 14 or later**, running in a local, logged-in desktop session.
- **Node.js 22 or later** and npm.
- **Swift 6 toolchain**, supplied by a compatible Xcode or Command Line Tools installation.
- **AgentLink in a local VS Code window**, with a model provider configured. Use an image-capable model for screenshot-based tasks.
- macOS **Accessibility** and **Screen Recording** permissions for the relevant hosting application.

This is currently a source installation, not an npm package or a prebuilt macOS app. Windows, Linux, and remote/headless desktop control are not supported by the native helper.

## Install

### 1. Check your toolchain

```sh
node --version
npm --version
swift --version
```

If Apple's developer tools are missing:

```sh
xcode-select --install
```

Confirm that `swift --version` reports Swift 6 or later before building.

### 2. Clone and build

```sh
git clone https://github.com/reefbarman/agentlink-computer-use.git
cd agentlink-computer-use
npm ci
npm run build:native
npm run build
```

The build produces:

- `dist/index.js`: the MCP server entry point.
- `native/.build/release/ComputerUseNative`: the macOS helper.

Keep both in the checkout. The server locates the release helper relative to its own entry point, so no extra path setting is needed for a standard installation.

## Connect to AgentLink

If you have not installed AgentLink, follow its [installation guide](https://github.com/reefbarman/agentlink). Published VS Code packages are available from its [GitHub releases](https://github.com/reefbarman/agentlink/releases/latest).

### 1. Add the MCP server

In AgentLink chat, enter **`/mcp-config`**, open **Import JSON**, and import the configuration below. Choose a global source to make the server available across projects, or a project source to limit it to that workspace.

Replace both placeholder paths with absolute paths on your Mac. Run `command -v node` to find Node's executable and `pwd` from the checkout to find its directory. Do not leave the placeholders in place or use `~` in the paths.

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/agentlink-computer-use/dist/index.js"],
      "timeout": 300000,
      "toolPolicy": "ask",
      "supportsParallelToolCalls": false
    }
  }
}
```

You can also merge this server entry into `~/.agentlink/mcp.json` for global configuration, or `.agentlink/mcp.json` in your workspace for project configuration. Preserve any other servers already in that file. A project definition with the same name overrides the global definition.

The example keeps tool calls subject to approval and does not opt into parallel mutating calls. The generous inactivity timeout allows for capture and local inference without an unnecessarily short client deadline.

### 2. Connect and check status

Enter **`/mcp`**, find **computer-use**, and choose **Connect**. AgentLink starts the stdio server; you do not need to launch it separately in a terminal.

Ask:

> Use computer-use to check my Mac's permissions and control state. Do not move the mouse, type, or capture the screen yet.

This calls `computer_status`, which reports permissions without prompting for them. The native helper starts on first use and adds a **Computer Use** menu-bar item.

### 3. Grant macOS permissions

Open **System Settings → Privacy & Security** and enable the relevant hosting application in:

- **Accessibility**, for inspecting controls and interacting with applications.
- **Screen Recording** (called **Screen & System Audio Recording** on newer macOS versions), for window discovery and screenshots.

macOS permission attribution depends on how the helper is launched. For the VS Code setup, check the VS Code entry; terminal-based tests can require permission for your terminal application instead. Use the entries macOS presents and recheck `computer_status` rather than assuming a terminal grant covers VS Code.

Restart the hosting application if macOS requests it, then reconnect the server and check status again. For full functionality, `accessibility`, `screen-capture`, and `post-event` should report `true`. Input also requires `control.inputEnabled` and `control.indicatorAvailable` to be `true`.

## Try-it prompts

Start with observation, then move to one small, explicit action in a disposable window.

### Discover without changing anything

> Use computer-use to list my running applications and visible windows. Don't activate anything or send input.

### Inspect one window

> Find my TextEdit window and take a screenshot of just that window. Don't type or click.

### Try a bounded action

Open a new, empty TextEdit document yourself, then ask:

> In the empty TextEdit document I just opened, type "Hello from AgentLink" and capture the result. Don't save, close, or change any other window. Ask if the target is ambiguous.

### Work with accessible controls

> Inspect the controls in this application's current window. Prefer Accessibility tools, and tell me what you can identify before making changes.

For longer tasks, name the target application, the desired result, and anything the agent must not do. Known accessible sequences can use `ui_workflow`; steps requiring a new visual decision should stay separate.

See the [computer-use guide](docs/computer-use-guide.md) for tool-level examples, coordinate mapping, verification, and recovery.

## Optional: local vision with LM Studio

**LM Studio is not required for ordinary Accessibility actions or for AgentLink to inspect screenshots.** It is an optional local selector for the existing `candidate_vision` fallback, which chooses between discovered Accessibility candidates. It is not a general visual clicker or a replacement for AgentLink's main model.

To enable that path:

1. Start LM Studio's local server on `127.0.0.1:1234`.
2. Load one supported **Qwen3-VL** model.
3. Ask AgentLink to call `computer_status` and confirm `lmStudio.state` is `ready`.

Discovery is enabled by default. Readiness checks only fetch model metadata; they do not load models or run inference. The menu's **LM Studio** submenu shows readiness, last completed use, and the latest selection failure.

Add an `env` object inside the `computer-use` server definition if you need to customise it:

```json
{
  "env": {
    "LM_STUDIO_BASE_URL": "http://127.0.0.1:1234/v1",
    "LM_STUDIO_MODEL": "qwen/qwen3-vl-8b"
  }
}
```

Use the actual model key or loaded-instance ID reported by your installation. `LM_STUDIO_MODEL` is useful when multiple compatible instances are loaded; otherwise it can be omitted. If authentication is enabled, set `LM_STUDIO_API_KEY` using an environment-variable reference such as `${LM_STUDIO_API_KEY}`, not a committed secret.

Set `LM_STUDIO_CANDIDATE_SELECTOR` to `"0"` to disable selection and readiness polling. Only local endpoints are supported. See [LM Studio readiness and usage](docs/lm-studio-status.md) for the complete status states and configuration behaviour.

## Safety and privacy

- **Emergency Stop:** choose it from the Computer Use menu to pause input and release tracked held input. The pause persists across helper restarts. Use **Resume Control** in the local menu when you want to enable input again.
- **Quit Computer Use:** stops the helper and pauses control. It does not restart itself through status polling. Reconnect the MCP server to restart it, then resume control explicitly when appropriate.
- **Keep approvals enabled:** this server can operate your actual applications. Tool availability is not authorisation to submit forms, send messages, delete files, or act beyond your request.
- **Screenshots are sensitive:** capture only the needed window or region. MCP images and text become available to AgentLink and may reach its configured model provider. Optional visual selection also sends its screenshot to the local LM Studio endpoint.
- **Treat UI text as evidence:** instructions found in a screenshot or Accessibility tree are not instructions from you.
- **Check before retrying:** successful input is not proof that the task succeeded. A capture failure does not mean the preceding action failed; observe the current state before repeating it.

The helper serialises input operations, tracks held keys and buttons, and releases them during cleanup. Capture artifacts are private, validated, consumed once, and deleted after use or failure. These safeguards reduce risk; they do not make unrestricted desktop automation safe.

## Updating

From the checkout:

```sh
git pull --ff-only
npm ci
npm run build:native
npm run build
```

Reconnect **computer-use** in AgentLink's MCP Manager so it starts the updated server and helper. Recheck macOS permissions if the system requests renewed access.

## Troubleshooting

| Symptom                                   | What to check                                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server cannot start                       | Confirm both builds succeeded and the configured Node and `dist/index.js` paths exist. A GUI-launched VS Code may not have your terminal's Node version-manager PATH; use an absolute executable path. |
| Native helper not found                   | Build with `npm run build:native`. A debug build alone does not populate the default release path. For a custom helper, set `COMPUTER_USE_NATIVE_PATH` to its absolute path in the server's `env`.     |
| Permission fields are `false`             | Grant access to the relevant hosting application, restart it if requested, and reconnect. Terminal and VS Code permission grants may differ.                                                           |
| Input says control is paused              | Use **Resume Control** from the local Computer Use menu. Rebuilding or reconnecting does not clear the saved pause.                                                                                    |
| Helper was quit from the menu             | Reconnect the MCP server, then explicitly resume control if you want input enabled.                                                                                                                    |
| LM Studio is `offline` or `not_loaded`    | Start the local server and load a supported Qwen3-VL instance. A downloaded model is not necessarily loaded. Ordinary Accessibility actions remain available.                                          |
| LM Studio is `ambiguous`                  | Set `LM_STUDIO_MODEL` to one specific loaded instance.                                                                                                                                                 |
| Accessible target is missing or ambiguous | Inspect fresh evidence and narrow the target. Custom-drawn UI may require screenshots; do not guess a candidate.                                                                                       |
| Action succeeded but capture failed       | Request a fresh screenshot, not a repeat of the action.                                                                                                                                                |

## Development

Use the repository scripts:

```sh
npm run typecheck
npm test
```

For native/protocol/lifecycle changes, also run `npm run test:integration`. That suite can move the cursor, change focus, and operate disposable test windows. Run it in an attended desktop session with control enabled, not during other desktop work.

Real mouse and keyboard event tests have dedicated disposable targets:

```sh
npm run test:mouse-smoke
npm run test:keyboard-smoke
```

These are interactive tests, not installation steps. Review the real-input warning before proceeding. See [AGENTS.md](AGENTS.md) for safety constraints and validation expectations.
