import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createForumMediaApi, sanitizeForumAttachments, sanitizeForumImageAttachments, validForumStorageKey } from "./media.ts";

function makeDeps() {
  return {
    httpError(status, message) {
      return Object.assign(new Error(message), { status });
    }
  };
}

describe("forum media", () => {
  it("validates forum media storage keys", () => {
    assert.equal(validForumStorageKey("forum/2026/06/file-name.png"), true);
    assert.equal(validForumStorageKey("avatars/file-name.png"), false);
    assert.equal(validForumStorageKey("forum/2026/../secret.png"), false);
    assert.equal(validForumStorageKey("forum/2026/06/<script>.png"), false);
  });

  it("sanitizes attachment records and deduplicates storage keys", () => {
    const attachments = sanitizeForumAttachments(
      [
        {
          storageKey: "forum/2026/06/report.pdf",
          fileName: "report.pdf",
          mimeType: "",
          fileSize: 1024
        },
        {
          storageKey: "forum/2026/06/report.pdf",
          fileName: "duplicate.pdf",
          mimeType: "application/pdf",
          fileSize: 2048
        }
      ],
      makeDeps()
    );

    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].storageProvider, "r2");
    assert.equal(attachments[0].mimeType, "application/pdf");
    assert.equal(attachments[0].publicUrl, "/api/forum/media/forum/2026/06/report.pdf");
  });

  it("requires reply attachments to be images", () => {
    assert.throws(
      () =>
        sanitizeForumImageAttachments(
          [
            {
              storageKey: "forum/2026/06/report.pdf",
              fileName: "report.pdf",
              mimeType: "application/pdf",
              fileSize: 1024
            }
          ],
          makeDeps()
        ),
      (error) => error.status === 400 && error.message === "invalid_forum_reply_attachment"
    );
  });

  it("serves UUID-versioned media with long-lived browser caching", async () => {
    const api = createForumMediaApi(makeDeps());
    const bucket = {
      async get() {
        return {
          body: new Blob(["image"]),
          customMetadata: { originalFileName: "avatar.png" },
          httpMetadata: { contentType: "image/png" },
          writeHttpMetadata(headers) {
            headers.set("Content-Type", "image/png");
          }
        };
      }
    };

    const response = await api.getForumMedia({ env: { FORUM_MEDIA: bucket } }, "forum%2F2026%2F08%2Favatar.png");

    assert.equal(response.headers.get("cache-control"), "private, max-age=31536000, immutable");
  });

  it("serves generated audio inline for browser playback", async () => {
    const api = createForumMediaApi(makeDeps());
    const bucket = {
      async get() {
        return {
          body: new Blob(["mp3"]),
          customMetadata: { originalFileName: "generated-audio.mp3" },
          httpMetadata: { contentType: "audio/mpeg" },
          writeHttpMetadata(headers) { headers.set("Content-Type", "audio/mpeg"); }
        };
      }
    };
    const response = await api.getForumMedia({ env: { FORUM_MEDIA: bucket } }, "forum%2F2026%2F09%2Fgenerated-audio.mp3");
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
    assert.match(response.headers.get("content-disposition"), /^inline;/);
  });

  it("deletes only an unclaimed draft owned by the current user", async () => {
    const deleted = [];
    const api = createForumMediaApi({
      httpError(status, message) {
        return Object.assign(new Error(message), { status });
      },
      requireDb: (db) => db,
      resolveCurrentUser: async () => ({ id: "user-1" })
    });
    const db = {
      prepare() {
        return {
          bind() {
            return { first: async () => null };
          }
        };
      }
    };
    const bucket = {
      delete: async (storageKey) => deleted.push(storageKey),
      head: async () => ({ customMetadata: { ownerUserId: "user-1" } })
    };

    const result = await api.deleteForumMediaDraft({
      env: { DB: db, FORUM_MEDIA: bucket },
      request: new Request("https://portal.test/api/forum/media/forum%2F2026%2F08%2Fdraft.png", { method: "DELETE" })
    }, "forum%2F2026%2F08%2Fdraft.png");

    assert.deepEqual(result, { deleted: true });
    assert.deepEqual(deleted, ["forum/2026/08/draft.png"]);
  });

  it("does not delete media after it has been attached to a post", async () => {
    const api = createForumMediaApi({
      httpError(status, message) {
        return Object.assign(new Error(message), { status });
      },
      requireDb: (db) => db,
      resolveCurrentUser: async () => ({ id: "user-1" })
    });
    const db = {
      prepare() {
        return {
          bind() {
            return { first: async () => ({ id: "attachment-1" }) };
          }
        };
      }
    };
    const bucket = {
      delete: async () => assert.fail("claimed media must not be deleted"),
      head: async () => ({ customMetadata: { ownerUserId: "user-1" } })
    };

    await assert.rejects(
      () => api.deleteForumMediaDraft({ env: { DB: db, FORUM_MEDIA: bucket } }, "forum/2026/08/claimed.png"),
      (error) => error.status === 409 && error.message === "forum_media_already_attached"
    );
  });
});
