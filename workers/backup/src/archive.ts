import { Zip, ZipDeflate } from "fflate";

const R2_MULTIPART_PART_SIZE = 5 * 1024 * 1024;
const EMPTY_BYTES = new Uint8Array(0);
const ZIP32_MAX_BYTES = 0xffff_ffff;
const ZIP32_MAX_ENTRIES = 0xffff;

export type BackupArchiveEntry = {
  kind: "d1_export" | "r2_object";
  sourceResourceId: string;
  sourceKey?: string;
  archivePath: string;
  contentType: string;
  sizeBytes: number;
};

export class BackupZipArchive {
  private readonly chunks: Uint8Array[] = [];
  private readonly filenameValue: string;
  private readonly keyValue: string;
  private readonly modifiedAt: Date;
  private readonly multipart: R2MultipartUpload;
  private readonly parts: R2UploadedPart[] = [];
  private readonly zip: Zip;
  private bufferedBytes = 0;
  private completed = false;
  private entryCount = 0;
  private finalChunkReceived = false;
  private generatedBytes = 0;
  private outputError: Error | undefined;
  private partNumber = 1;

  private constructor(multipart: R2MultipartUpload, key: string, filename: string, modifiedAt: Date) {
    this.multipart = multipart;
    this.keyValue = key;
    this.filenameValue = filename;
    this.modifiedAt = modifiedAt;
    this.zip = new Zip((error, chunk, final) => {
      if (error) {
        this.outputError = error;
        return;
      }
      if (chunk.byteLength) {
        this.generatedBytes += chunk.byteLength;
        if (this.generatedBytes > ZIP32_MAX_BYTES) {
          this.outputError = new Error("backup_zip_requires_zip64");
          return;
        }
        this.chunks.push(chunk);
        this.bufferedBytes += chunk.byteLength;
      }
      if (final) this.finalChunkReceived = true;
    });
  }

  static async create(bucket: R2Bucket, key: string, filename: string, modifiedAt: Date) {
    const multipart = await bucket.createMultipartUpload(key, {
      httpMetadata: {
        cacheControl: "private, no-store",
        contentDisposition: `attachment; filename="${safeDownloadFilename(filename)}"`,
        contentType: "application/zip"
      }
    });
    return new BackupZipArchive(multipart, key, filename, modifiedAt);
  }

  get key() {
    return this.keyValue;
  }

  get filename() {
    return this.filenameValue;
  }

  async addStream(path: string, stream: ReadableStream<Uint8Array>) {
    this.beginEntry();
    const input = new ZipDeflate(safeArchivePath(path), { level: 3 });
    input.mtime = this.modifiedAt;
    this.zip.add(input);
    const reader = stream.getReader();
    let sizeBytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        if (sizeBytes + value.byteLength > ZIP32_MAX_BYTES) throw new Error("backup_zip_entry_requires_zip64");
        sizeBytes += value.byteLength;
        input.push(value);
        this.throwOutputError();
        await this.uploadCompleteParts();
      }
      input.push(EMPTY_BYTES, true);
      this.throwOutputError();
      await this.uploadCompleteParts();
      return sizeBytes;
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async addText(path: string, value: string) {
    this.beginEntry();
    const bytes = new TextEncoder().encode(value);
    const input = new ZipDeflate(safeArchivePath(path), { level: 3 });
    input.mtime = this.modifiedAt;
    this.zip.add(input);
    input.push(bytes, true);
    this.throwOutputError();
    await this.uploadCompleteParts();
    return bytes.byteLength;
  }

  async finish() {
    this.assertWritable();
    this.zip.end();
    this.throwOutputError();
    if (!this.finalChunkReceived) throw new Error("backup_zip_incomplete");
    await this.uploadCompleteParts();
    if (this.bufferedBytes) await this.uploadPart(this.takeBytes(this.bufferedBytes));
    const object = await this.multipart.complete(this.parts);
    this.completed = true;
    return object;
  }

  async abort() {
    if (this.completed) return;
    this.zip.terminate();
    await this.multipart.abort();
  }

  private assertWritable() {
    if (this.completed) throw new Error("backup_zip_already_completed");
    this.throwOutputError();
  }

  private beginEntry() {
    this.assertWritable();
    this.entryCount += 1;
    if (this.entryCount > ZIP32_MAX_ENTRIES) throw new Error("backup_zip_too_many_entries");
  }

  private throwOutputError() {
    if (this.outputError) throw this.outputError;
  }

  private async uploadCompleteParts() {
    while (this.bufferedBytes >= R2_MULTIPART_PART_SIZE) {
      await this.uploadPart(this.takeBytes(R2_MULTIPART_PART_SIZE));
    }
  }

  private async uploadPart(bytes: Uint8Array) {
    if (this.partNumber > 10_000) throw new Error("backup_zip_too_many_parts");
    this.parts.push(await this.multipart.uploadPart(this.partNumber, bytes));
    this.partNumber += 1;
  }

  private takeBytes(size: number) {
    const output = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const chunk = this.chunks[0];
      const remaining = size - offset;
      const copyLength = Math.min(chunk.byteLength, remaining);
      output.set(chunk.subarray(0, copyLength), offset);
      offset += copyLength;
      if (copyLength === chunk.byteLength) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(copyLength);
    }
    this.bufferedBytes -= size;
    return output;
  }
}

export function d1ArchivePath(resourceName: string) {
  return `d1/${safeDownloadFilename(resourceName)}.sql`;
}

export function r2ArchivePath(bucketName: string, objectKey: string) {
  return `r2/${safeDownloadFilename(bucketName)}/${safeR2ObjectPath(objectKey)}`;
}

export function backupArchiveFilename(appCode: string, createdAt: string, jobId: string) {
  return `${safeDownloadFilename(appCode)}-${createdAt.slice(0, 10)}-${safeDownloadFilename(jobId)}.zip`;
}

function safeR2ObjectPath(value: string) {
  const segments = value.split("/").map((segment) => {
    if (!segment) return "%2F";
    if (segment === ".") return "%2E";
    if (segment === "..") return "%2E%2E";
    return segment.replace(/\\/g, "%5C").replace(/\0/g, "%00");
  });
  return segments.join("/") || "object";
}

function safeArchivePath(value: string) {
  return value.replace(/^\/+/, "").split("/").map(safeArchiveSegment).join("/") || "backup-file";
}

function safeArchiveSegment(value: string) {
  if (value === ".") return "%2E";
  if (value === "..") return "%2E%2E";
  return value.replace(/\\/g, "%5C").replace(/\0/g, "%00") || "%2F";
}

function safeDownloadFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 180) || "backup";
}
