import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  avatarContentVersion,
  cacheableUserAvatarUrl,
  userAvatarImageResponse
} from "./avatar.ts";

const avatar = "data:image/png;base64,SGVsbG8=";

describe("cacheable user avatars", () => {
  it("replaces inline image data with a stable content-versioned URL", () => {
    const expected = `/api/users/user-1/avatar?v=${avatarContentVersion(avatar)}`;

    assert.equal(cacheableUserAvatarUrl("user-1", avatar), expected);
    assert.equal(cacheableUserAvatarUrl("user-1", avatar), expected);
    assert.notEqual(cacheableUserAvatarUrl("user-1", `${avatar}AA==`), expected);
    assert.equal(cacheableUserAvatarUrl("user-1", "https://cdn.example.test/avatar.png"), "https://cdn.example.test/avatar.png");
  });

  it("serves versioned bytes with immutable private caching and ETag validation", async () => {
    const version = avatarContentVersion(avatar);
    const response = userAvatarImageResponse(avatar, version, new Headers());

    assert.ok(response);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(await response.text(), "Hello");

    const cached = userAvatarImageResponse(avatar, version, new Headers({
      "if-none-match": response.headers.get("etag")
    }));
    assert.equal(cached?.status, 304);
  });

  it("rejects stale versions and non-inline values", () => {
    assert.equal(userAvatarImageResponse(avatar, "stale", new Headers()), undefined);
    assert.equal(userAvatarImageResponse("https://cdn.example.test/avatar.png", "v1", new Headers()), undefined);
  });
});
