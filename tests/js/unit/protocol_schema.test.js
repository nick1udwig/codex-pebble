import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const clientRequestSchema = JSON.parse(
  readFileSync(new URL("../../../schemas/ClientRequest.json", import.meta.url), "utf8"),
);
const serverNotificationSchema = JSON.parse(
  readFileSync(new URL("../../../schemas/ServerNotification.json", import.meta.url), "utf8"),
);
const userInputTypes = readFileSync(
  new URL("../../../schemas/v2/UserInput.ts", import.meta.url),
  "utf8",
);

describe("generated Codex app-server protocol schema", () => {
  it("keeps turn reply inputs tied to generated UserInput shape", () => {
    const definitions = clientRequestSchema.definitions;
    const textInput = definitions.UserInput.oneOf.find(option => {
      return option.title === "TextUserInput";
    });

    expect(definitions.TurnStartParams.required).toEqual(expect.arrayContaining(["threadId", "input"]));
    expect(definitions.TurnSteerParams.required).toEqual(
      expect.arrayContaining(["threadId", "input", "expectedTurnId"]),
    );
    expect(definitions.TurnStartParams.properties.input.items.$ref).toBe("#/definitions/UserInput");
    expect(definitions.TurnSteerParams.properties.input.items.$ref).toBe("#/definitions/UserInput");
    expect(textInput.properties.text_elements.default).toEqual([]);
    expect(userInputTypes).toContain("text_elements: Array<TextElement>");
  });

  it("includes item lifecycle notifications used for live progress", () => {
    const notificationMethods = serverNotificationSchema.oneOf.flatMap(option => {
      return option.properties && option.properties.method
        ? option.properties.method.enum || []
        : [];
    });

    expect(notificationMethods).toContain("item/started");
    expect(notificationMethods).toContain("item/completed");
    expect(serverNotificationSchema.definitions.ItemStartedNotification.required).toEqual(
      expect.arrayContaining(["item", "threadId", "turnId", "startedAtMs"]),
    );
    expect(serverNotificationSchema.definitions.ItemCompletedNotification.required).toEqual(
      expect.arrayContaining(["item", "threadId", "turnId", "completedAtMs"]),
    );
  });
});
