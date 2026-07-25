import { deleteSession, getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { LocalClient } from "./LocalClient";

describe("LocalClient Behavior", () => {
  it("answers the last turn of a transcript without inventing a user turn", async () => {
    const client = new LocalClient();

    await client
      .sendMessage([
        { role: "user", content: "My favorite color is blue." },
        { role: "assistant", content: "Noted: your favorite color is blue." },
        {
          role: "user",
          content: "Reply with only that color, a single word.",
        },
      ])
      .then((segments) => {
        const reply = segments.join(" ");
        expect(reply).toMatch(/blue/i);
        expect(reply).not.toMatch(/<turn|user:/i);
      })
      .finally(async () => {
        await Promise.all(
          client.sessionIds.map((sessionId) =>
            deleteSession(sessionId).catch(() => undefined),
          ),
        );
        await client.destroy();
      });
  }, 30_000);

  it("should not persist a session to disk after sendMessage", async () => {
    const client = new LocalClient();

    await client
      .sendMessage([
        { role: "user", content: "Reply with the single word: pong" },
      ])
      .then(async () => {
        expect(client.sessionIds.length).toBeGreaterThan(0);
        for (const sessionId of client.sessionIds) {
          expect(await getSessionInfo(sessionId)).toBeUndefined();
        }
      })
      .finally(async () => {
        await Promise.all(
          (client.sessionIds ?? []).map((sessionId) =>
            deleteSession(sessionId).catch(() => undefined),
          ),
        );
        await client.destroy();
      });
  }, 30_000);
});
