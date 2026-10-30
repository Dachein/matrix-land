import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FORUM_ANONYMOUS_PERSONAS,
  randomForumAnonymousPersona
} from "./forumAnonymousIdentity.ts";

describe("forum anonymous identity", () => {
  it("always changes persona when refreshing", () => {
    for (const persona of FORUM_ANONYMOUS_PERSONAS) {
      const refreshedPersona = randomForumAnonymousPersona(persona.key);
      assert.notEqual(refreshedPersona, persona.key);
      assert.ok(FORUM_ANONYMOUS_PERSONAS.some((candidate) => candidate.key === refreshedPersona));
    }
  });
});
