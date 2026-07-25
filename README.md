# @bmichaellee/ai-provider

An LLM client with interchangeable backends behind one provider-agnostic
interface. Calling code targets `AIProvider` — messages in, text segments out,
with tools and streaming callbacks — and never a vendor SDK, so backends for
other model families can be added without touching call sites. Two Claude
backends ship today:

- **`anthropic`** — the Anthropic API via `@anthropic-ai/sdk`, with its own
  sequential, order-preserving tool loop.
- **`local`** — a local Claude Code install via `@anthropic-ai/claude-agent-sdk`,
  with tools exposed as an in-process MCP server. No API key, no per-token cost:
  ideal for development and testing.

```ts
import { createProvider } from "@bmichaellee/ai-provider";

const ai = createProvider();

const segments = await ai.sendMessage([{ role: "user", content: "Hello!" }], {
  system: "Be helpful.",
  onText: (segment) => process.stdout.write(segment),
});

await ai.destroy();
```

## Backend selection

`createProvider()` with no arguments keeps things automatic: if
`ANTHROPIC_API_KEY` is set (or `apiKey` is passed), you get the Anthropic
backend; otherwise the local one. Every choice can also be explicit:

```ts
createProvider(); // env-sniff
createProvider({ apiKey: key }); // Anthropic, key without env
createProvider({ backend: "anthropic" }); // force API (key from env)
createProvider({ backend: "local" }); // force local Claude Code
```

The local backend requires the optional peer `@anthropic-ai/claude-agent-sdk`
**and** a logged-in Claude Code install on the machine. It is a development-machine
backend: headless servers and CI runners without a Claude Code login cannot use it.

Every client exposes which backend it is as `providerKind` (`"anthropic"` or
`"local"`), and each usage event echoes it. Check
`provider.providerKind === "local"` for the keyless development backend instead
of sniffing `ANTHROPIC_API_KEY` yourself — anything other than `"local"` is a
metered API.

## Tools

A tool is a name, a description, a zod v4 object schema, and a `run` function
returning a string:

```ts
import { z } from "zod";
import type { ToolSpec } from "@bmichaellee/ai-provider";

const roll: ToolSpec = {
  name: "roll_die",
  description: "Roll a die with the given number of sides.",
  schema: z.object({ sides: z.number().int().min(2) }),
  run: async ({ sides }) => String(1 + Math.floor(Math.random() * sides)),
};
```

Tools receive a `ToolContext` as their second argument:

- `ctx.stop` — set it to `true` to end the conversation turn: no further model
  turns run. On the `local` backend, model text later in the stream is suppressed
  too; on the `anthropic` backend, text the model already placed after the tool
  call _within the same message_ is still emitted. If the turn ends with no text
  at all, the optional `stopText` send option is emitted instead (nothing is
  emitted by default).
- `ctx.app` — an app-defined context object, passed through verbatim from the
  `context` send option. Type it by parameterizing: `ToolSpec<Input, MyContext>`.

```ts
await ai.sendMessage(messages, {
  tools: [roll],
  context: { session }, // arrives as ctx.app
  stopText: "[The conversation ends.]", // emitted on a silent stop
  onUsage: (usage) => console.log(usage.percentUsed, "% of context used"),
});
```

## Usage reporting

`onUsage` fires once per underlying model API call, on both backends. Each
`ContextUsage` describes that single call: `inputTokens` and the cache fields
are the prompt actually sent, `outputTokens` is that call's completion, and
`percentUsed` is `(inputTokens + cacheCreationInputTokens +
cacheReadInputTokens) / contextWindow * 100`, rounded to one decimal — the
live fullness of the context window for that request, on a 0–100 scale. A
single `sendMessage()` may perform several calls (one per tool-loop
iteration, numbered by `iteration`), so you may receive several events; the
**last** event's `percentUsed` is the current window fullness. Never sum
token fields or `percentUsed` across events to estimate fullness. On the
local backend, API calls made by subagents (e.g. the built-in Task tool) are
excluded — they describe a subagent's context, not yours; their spend still
shows up in `onTurnUsage` totals.

For the turn's total spend, use `onTurnUsage`. It fires at most once per
`sendMessage()`, after the final model call, with token counts accumulated
across every call in the turn — and, on the local backend, the
provider-reported `costUSD` and authoritative `contextWindow`. `TurnUsage`
intentionally has no `percentUsed`: cumulative tokens divided by the window is
not a meaningful fullness number. Window fullness lives in `onUsage`; turn
cost lives in `onTurnUsage`.

On the local backend, every `ContextUsage` also carries
`sessionOverheadTokens` (the exported `LOCAL_SESSION_OVERHEAD_TOKENS`
estimate, ~65k): Claude Code's built-in tool schemas and machinery occupy that
much of each call's context beyond what you supplied. Budget app content
against `contextWindow - sessionOverheadTokens`.

## The local backend keeps its built-in tools

`allowedTools` allowlists the app's MCP tools; it does not — and deliberately
does not try to — disable the local Claude Code session's built-ins
(WebSearch, Read, Bash, ...). They stay live **by design**: tool suppression
breeds refusal; honesty works. The session is told, truthfully, what it is
helping with, and it plays along.

The consumer-side half of that contract is an app-supplied honest preamble via
`system`, telling the session what it is really doing. For example, a
development harness might ship:

```ts
const system =
  "You are narrating for a game engine under development. Your replies are " +
  "parsed as story text, so keep working notes out of the reply itself. It " +
  "is fine to use your tools; report anything unusual through them, not in " +
  "the narration.";
```

Built-in tool runs surface through the `onToolActivity` send option instead of
being silently absorbed: a `start` event when the session invokes a tool (name
plus a one-line input summary), an `end` event when its result lands, and a
`commentary` event carrying any model text that shared a message with the tool
call ("let the search finish"). That commentary is diverted out of the
returned segments and `onText` — it is working narration about the tool run,
not content — so transcripts stay clean whether or not you listen:

```ts
await ai.sendMessage(messages, {
  onToolActivity: (a) => console.log(`[${a.phase}] ${a.summary}`),
});
```

Multi-turn conversations are sent to the local session as a closed
`<conversation-transcript>` block plus a standing system instruction to write
only the assistant's next turn — so the model has no dangling `user:` prefix
to complete and cannot drift into answering an invented user message.

## Other providers

Today the package is Claude through and through: both backends are Claude, and
the exported model catalog (`ClaudeModels`, `ClaudeMaxTokens`,
`ClaudeContextWindow`, `ClaudeEffort`) is Claude's. The source layout draws
the line: everything Claude-specific — both clients and the model catalog —
lives in `src/providers/anthropic/`, and the root of `src/` is
provider-agnostic. A new provider is a sibling directory under
`src/providers/` — an `AIProvider` implementation exported through the
`providers/` barrel, plus a `ProviderBackend` entry in `createProvider` —
with its model catalog sitting alongside the Claude one. Existing call sites
keep working unchanged.

## Environment

- `ANTHROPIC_API_KEY` — selects and authenticates the Anthropic backend when no
  explicit config is given.
- `DEBUG_TOOL_CALLS` — when set, logs every tool invocation (name, input, result)
  to the console.

## Peer dependencies

- `zod` ^4 (tool schemas; v4's `z.toJSONSchema` is used)
- `@anthropic-ai/sdk` (Anthropic backend)
- `@anthropic-ai/claude-agent-sdk` — optional; only needed for the local backend

## Releasing

Publishing to npm runs through the `Publish` GitHub Actions workflow
(`.github/workflows/publish.yml`), dispatched manually from `main` with a
`bump` input (`patch`/`minor`/`major`). It bumps this package's `version`,
commits and pushes that bump to `main` as `github-actions[bot]`, runs
`npm publish` (which builds `dist/` via `prepublishOnly`), and tags the
release `v<x.y.z>`. There's no manual publish path — always go through the
workflow so the version bump, the npm release, and the git tag stay in sync.
