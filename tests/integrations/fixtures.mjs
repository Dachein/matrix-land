import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export class TestD1 {
  constructor(schema) { this.database = new DatabaseSync(":memory:"); this.database.exec(readFileSync(schema, "utf8")); }
  prepare(sql) {
    const statement = this.database.prepare(sql);
    const make = (params = []) => ({
      bind: (...next) => make(next),
      first: async () => statement.get(...params) || null,
      all: async () => ({ results: statement.all(...params) }),
      run: async () => ({ meta: { changes: Number(statement.run(...params).changes) }, success: true })
    });
    return make();
  }
  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = []; for (const statement of statements) result.push(await statement.run()); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}

export class TestR2 {
  objects = new Map(); uploads = []; aborted = 0;
  async put(key, bytes) { this.objects.set(key, new Uint8Array(bytes)); }
  async delete(key) { this.objects.delete(key); }
  async head(key) { return this.objects.has(key) ? { size: this.objects.get(key).length } : null; }
  async get(key, options) {
    const value = this.objects.get(key);
    if (!value) return null;
    const bytes = options?.range ? value.slice(options.range.offset, options.range.offset + options.range.length) : value;
    return { body: bytes, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer };
  }
  async createMultipartUpload(key) {
    const chunks = [], sizes = []; this.uploads.push(sizes);
    return {
      uploadPart: async (number, bytes) => { chunks.push(bytes.slice()); sizes.push(bytes.length); return { partNumber: number, etag: String(number) }; },
      complete: async () => {
        const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
        let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        this.objects.set(key, bytes); return {};
      },
      abort: async () => { this.aborted++; }
    };
  }
}
