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

Where you need the answer but hold no provider — a health check, a startup
banner — `resolveProviderKind()` applies the same rules without constructing
one:

```ts
import { resolveProviderKind } from "@bmichaellee/ai-provider";

resolveProviderKind(); // "anthropic" | "local", from the same env/config rules
resolveProviderKind({ backend: "local" }); // "local"
```

## Models

`ClaudeModels` names one model per family, and each name always points at the
latest release of that family:

```ts
ClaudeModels.Sonnet; // claude-sonnet-5
ClaudeModels.Opus; // claude-opus-5
ClaudeModels.Haiku; // claude-haiku-4-5
ClaudeModels.Fable; // claude-fable-5
```

Because the names track the latest release, upgrading this package can change
which model a name resolves to — see the changelog for any release that moves
one. Superseded models stay selectable by literal (`"claude-opus-4-8"` is still
a valid `ClaudeModel` with a full catalog entry); they simply lose their named
constant, so pinning is explicit.

Model ids from a config file, a request body, or a database row are just
strings. Validate them with `claudeModelSchema`, and size budgets with the
total lookups, which fall back to the default model rather than returning
`undefined` for a model the catalog has not heard of:

```ts
claudeModelSchema.parse(row.model); // throws on an unknown id
contextWindowFor(row.model); // always a positive number
maxTokensFor(row.model);
supportsEffort(row.model);
```

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

On the local backend, every `ContextUsage` **and** `TurnUsage` also carries
`sessionOverheadTokens` (the exported `LOCAL_SESSION_OVERHEAD_TOKENS`
estimate, ~65k): Claude Code's built-in tool schemas and machinery occupy that
much of each call's context beyond what you supplied. Budget app content
against `contextWindow - sessionOverheadTokens`. It is a per-call figure on
both events — never multiply it by `iterationCount`.

Every field above is also exported as a runtime schema — `contextUsageSchema`,
`turnUsageSchema`, `toolActivitySchema` — so a consumer that needs to validate
or re-publish these events can derive from them rather than hand-mirroring the
types and re-breaking on every field this package adds.

## When the model declines

Both backends throw `RefusalError` when the model refuses a request, rather
than resolving with an empty segment list that reads as a successful turn with
nothing to say. On the local backend, a refusal the Claude Code harness
retried successfully on a fallback model is not a refusal from your side and
does not throw.

```ts
import { isRefusalError } from "@bmichaellee/ai-provider";

try {
  await ai.sendMessage(messages);
} catch (error) {
  if (isRefusalError(error)) {
    // error.category  — "cyber" | "bio" | ... | null, open-ended
    // error.explanation — provider prose, display only
    // error.providerKind, error.model
  }
}
```

`onTurnUsage` fires before the throw: the calls were made and, on a metered
backend, billed. Prefer `isRefusalError()` to `instanceof RefusalError` at a
package boundary — a consumer that resolves two copies of this package gets
two distinct classes, and `instanceof` quietly returns false for one of them.

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

- `zod` ^4 (tool schemas and the exported runtime schemas; v4's
  `z.toJSONSchema` is used)
- `@anthropic-ai/sdk` >=0.115.0 (Anthropic backend)
- `@anthropic-ai/claude-agent-sdk` >=0.3.220 — optional; only needed for the
  local backend

The floors are the versions this package is built and tested against. The
agent-SDK floor in particular is not cosmetic: releases before 0.3.220 report a
200,000-token context window for Claude Opus 5, which this package would
forward through `onTurnUsage` as authoritative.

## Releasing

Publishing to npm runs through the `Publish` GitHub Actions workflow
(`.github/workflows/publish.yml`), dispatched manually from `main` with a
`bump` input (`patch`/`minor`/`major`). It bumps this package's `version`,
commits and pushes that bump to `main` as `github-actions[bot]`, runs
`npm publish` (which builds `dist/` via `prepublishOnly`), and tags the
release `v<x.y.z>`. There's no manual publish path — always go through the
workflow so the version bump, the npm release, and the git tag stay in sync.
