# Changelog

## 0.4.0

Adds an opt-in `onThinking` send option, so a consumer can read the model's
reasoning instead of having it dropped before it ever arrives.

### Added

- **`SendOptions.onThinking`** — fires once per thinking block, ahead of the
  text of the call that produced it, on both backends. Thinking is a side
  channel: it never enters the returned segments or `onText`, is never replayed
  to the model, and on the local backend it is routed clear of the
  `onToolActivity` commentary channel even when the model reasons in the same
  message as a built-in tool call. Subagent reasoning is excluded, as subagent
  usage already is.

  Registering the callback is also what turns the output on. Both backends now
  send `thinking.display: "summarized"` when `onThinking` is set and
  `"omitted"` when it is not — forwarding the blocks alone would not have been
  enough, because every model in the catalog defaults the display to
  `"omitted"` and returns thinking blocks whose text is the empty string.

  This is a visibility switch, not a thinking switch. Both backends already
  requested adaptive thinking, and the model reasons and bills the same under
  either display setting, so listening adds the summary tokens and nothing
  else. Consumers that do not pass the callback see 0.3.0 behavior unchanged.

  What arrives is a provider-side summary, not the raw chain of thought, which
  no current model exposes. A model may decline to summarize and send nothing,
  so treat the stream as advisory. As with `onText`, a delivered segment cannot
  be recalled: when the local harness retries a refusal on a fallback model it
  retracts the refused leg's text from the returned segments, but thinking
  already handed to the callback has been handed over.

  No runtime schema accompanies it — `onThinking` carries a plain string, as
  `onText` does, and neither has one.

## 0.3.0

A breaking release: Claude Opus 5 support, two silent-failure paths made loud,
and runtime schemas so consumers can derive the event types instead of
mirroring them.

### Behavior changes to absorb first

**Thinking is now requested explicitly on the Anthropic backend.** Previously
the backend sent no `thinking` parameter, so whether the model reasoned was a
property of the model: Opus 4.8 did not think, Sonnet 5 did. The local backend
has always requested adaptive thinking. The same model therefore behaved — and
cost — differently depending on which backend answered. Both now request
`{ type: "adaptive" }`.

Combined with the `ClaudeModels.Opus` repoint below, an existing Opus caller on
the Anthropic backend goes from no thinking to adaptive thinking. Expect higher
`outputTokens` (thinking bills as output), higher latency, and higher cost per
turn. This is the intended default for the model, but it is invisible to the
type system, so it is the first thing to check after upgrading.

### Breaking

- **`ClaudeModels.Opus` now points at `claude-opus-5`** (was `claude-opus-4-8`).
  Bare family names track the latest release of that family. `claude-opus-4-8`
  remains fully supported — it stays in the `ClaudeModel` union and in every
  catalog map — but has no named constant; select it by literal if you want it
  pinned.
- **`ContextUsage.iteration`, `ContextUsage.providerKind`,
  `TurnUsage.providerKind` and `TurnUsage.contextWindow` are now required.**
  Both backends always set them, so readers can drop their `??` fallbacks. Note
  this breaks *constructors*, not just readers: test fixtures and fakes that
  build these objects will need the fields added.
- **A refusal now throws.** See below.
- **Peer floors raised** to `@anthropic-ai/sdk >=0.115.0` and
  `@anthropic-ai/claude-agent-sdk >=0.3.220` — the versions this package is
  built and tested against. The agent-SDK floor is load-bearing: 0.3.215 and
  earlier report a 200,000-token context window for Opus 5 (verified by
  downgrade and retest), which this package would forward through
  `onTurnUsage` as though it were authoritative.

### Added

- **`claude-opus-5`** in the model catalog: 1M context window, 128K max output,
  effort supported.
- **`RefusalError`**, thrown when the model declines a request. Previously an
  Anthropic refusal arrived as an empty, successful turn — `sendMessage`
  resolved with `[]`, no callback fired, and there was nothing to distinguish a
  refusal from a model with nothing to say. Carries `providerKind`, `model`,
  `category` and `explanation`. Both backends detect it; the local backend
  reads the Agent SDK's `model_refusal_no_fallback` message and, for older CLIs
  that do not emit it, the result's `stop_reason`. A refusal the harness
  successfully retried on a fallback model is *not* an error and does not
  throw. `RefusalError.model` names the model that actually ran, which on the
  local backend is not always the one asked for — with no explicit model the
  session runs the CLI's own default. Ship `isRefusalError()` rather than
  `instanceof` if a consumer may resolve two copies of this package.
- **Retracted content is withheld on the local backend.** When the Claude Code
  harness refuses and then retries on a fallback model, it voids the refused
  leg's partial answer. That retraction is now honoured: text named by an
  assistant frame's `supersedes` or by the end-of-turn notice's
  `retracted_message_uuids` is dropped before it is emitted, or removed from
  the returned segments if it was emitted already. Previously the refused
  partial — potentially the opening of the answer the model declined to
  give — was returned to the caller, concatenated ahead of the retry's real
  answer. An `onText` callback that has already fired cannot be recalled, so
  consumers rendering the stream live should treat a retraction-carrying frame
  as replacing what preceded it.
- **Runtime zod schemas** — `contextUsageSchema`, `turnUsageSchema`,
  `toolActivitySchema`, `providerKindSchema`, `toolActivityPhaseSchema`, plus
  `claudeModelSchema` and `claudeEffortSchema`. Consumers hand-mirroring these
  shapes (and asserting equivalence against our exported types) should delete
  the mirror and import these: every field added here used to be a downstream
  typecheck break. Compile-time assertions in this package keep each schema and
  its type in lockstep.
- **`resolveProviderKind(config?)`** — which backend a config selects, without
  constructing one. For call sites that need the answer but hold no provider,
  such as a health check, instead of reading `ANTHROPIC_API_KEY` directly.
- **`contextWindowFor(model)`, `maxTokensFor(model)`, `supportsEffort(model)`,
  `DEFAULT_CONTEXT_WINDOW`** — total lookups over arbitrary model strings, for
  consumers holding a model id from config or a database row.
- **`TurnUsage.sessionOverheadTokens`** (local backend). The documented budget
  recipe is `contextWindow - sessionOverheadTokens`, but the authoritative
  window is reported on `TurnUsage` while the overhead was only on
  `ContextUsage` — the recipe could not be applied from a single event. It is
  the same per-call figure, not a turn total: do not multiply by
  `iterationCount`.

### Fixed

- **An unknown model no longer produces a `NaN` fullness.** A model string
  outside the catalog — a Claude Code alias like `"opus"`, a stale database
  row, a model newer than the installed package — produced
  `percentUsed: NaN`, which serializes to `null` and silently blanks a
  consumer's meter. Lookups now fall back to the default model's window.
- **A provider-reported context window of `0` or `NaN` is no longer trusted.**
  Previously only `null`/`undefined` fell back, so a zero could reach
  `TurnUsage.contextWindow` and drive a budget negative.
- **Exceeding the tool-turn limit now reports usage before throwing.** Up to
  eight paid API calls previously went unreported because the throw skipped
  `onTurnUsage`.

### Known gaps

- `stop_reason: "model_context_window_exceeded"` and `"max_tokens"` are still
  returned as ordinary successful turns on the Anthropic backend — the same
  silent-success shape as the refusal bug fixed here. Deliberately out of scope
  for this release.
- Text written in the same API message as a stopping tool call survives on the
  Anthropic backend but is suppressed on the local one. A real divergence,
  pinned per-backend in the tests rather than papered over.
- `TurnUsage.contextWindow` on the local backend is only as good as the
  installed Agent SDK reports; a wrong-but-plausible number cannot be detected
  here, which is what the peer floor is for.

## 0.2.0

Per-call `onUsage`, `onTurnUsage`, `onToolActivity`, `providerKind`, and
phantom-turn hardening. See the release notes for
[v0.2.0](https://github.com/bmichaellee/ai-provider/releases/tag/v0.2.0).
