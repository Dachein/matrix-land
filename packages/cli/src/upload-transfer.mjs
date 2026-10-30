import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { callMcpTool } from "./mcp-client.mjs";
import { mcpToolPayload } from "./mcp-result.mjs";

const MAX_UPLOAD_BYTES = 30_000_000_000 - 1;
const MAX_R2_PUT_BYTES = 5 * 1024 * 1024 * 1024;
const TUS_CHUNK_BYTES = 50 * 1024 * 1024;
const MIME_BY_EXTENSION = new Map([
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".webm", "video/webm"],
  [".mov", "video/quicktime"],
]);

export async function transferUpload(input, options = {}) {
  if (input.resumePath) return resumeUpload(input, options);

  const originalPath = resolve(input.filePath);
  await regularFileInfo(originalPath);
  let filePath = originalPath;
  let compressedDirectory;
  let checkpointPath;
  let checkpointWritten = false;
  try {
    if (input.compress) {
      const compressed = await compressVideo(originalPath, input.ffmpegBin, options);
      filePath = compressed.filePath;
      compressedDirectory = compressed.directory;
    }

    const fileInfo = await regularFileInfo(filePath);
    const mimeType = MIME_BY_EXTENSION.get(extname(filePath).toLowerCase()) ?? "application/octet-stream";
    const descriptor = await readUploadDescriptor(input.requestPath);
    const file = {
      fileName: basename(filePath),
      mimeType,
      sizeBytes: fileInfo.size,
    };
    const prepared = await prepareUpload(descriptor, file, options);
    const upload = prepared.upload;
    validateUploadDescriptor(upload, fileInfo.size);

    let state;
    if (upload.protocol === "tus" || descriptor.complete) {
      const stateDirectory = await ensurePrivateUploadDirectory(options.home ?? homedir());
      checkpointPath = join(stateDirectory, `${randomUUID()}.json`);
      state = {
        version: 1,
        phase: "upload",
        provider: upload.provider,
        upload,
        complete: descriptor.complete,
        prepareResult: prepared.prepareResult,
        file,
        filePath,
        fileSize: fileInfo.size,
        fileMtimeMs: fileInfo.mtimeMs,
        compressedDirectory,
        createdAt: new Date().toISOString(),
      };
      await writeCheckpoint(checkpointPath, state, true);
      checkpointWritten = true;
      if (upload.protocol === "tus" || descriptor.complete) writeLine(options.stderr, `Resume file: ${checkpointPath}`);
    }

    await transferBytes(upload, filePath, fileInfo.size, file.mimeType, options);
    if (state?.complete) {
      state.phase = "complete";
      await writeCheckpoint(checkpointPath, state);
      await executeAction(state.complete, actionContext(state), options);
    }

    if (checkpointPath) await rm(checkpointPath, { force: true });
    if (compressedDirectory) await rm(compressedDirectory, { recursive: true, force: true });
    return {
      provider: upload.provider,
      uploadedBytes: fileInfo.size,
      protocol: upload.protocol,
      status: "complete",
    };
  } catch (error) {
    if (compressedDirectory && !checkpointWritten) await rm(compressedDirectory, { recursive: true, force: true }).catch(() => {});
    if (checkpointWritten && checkpointPath && error instanceof Error) {
      error.message = `${error.message}. Resume with: frontier-workspace upload --resume "${checkpointPath}"`;
    }
    throw error;
  }
}

async function transferBytes(upload, filePath, fileSize, mimeType, options) {
  if (upload.protocol === "tus") {
    await uploadTus(upload.uploadUrl, filePath, fileSize, options, upload.headers);
  } else if (upload.provider === "media" && upload.protocol === "post") {
    await uploadMultipart(upload.uploadUrl, filePath, basename(filePath), mimeType, fileSize, options, upload.headers);
  } else if (upload.provider === "r2" && upload.protocol === "put") {
    await uploadPut(upload.uploadUrl, filePath, fileSize, options, upload.headers);
  } else {
    throw new Error(`Unsupported upload provider/protocol: ${upload.provider}/${upload.protocol}`);
  }
}

async function resumeUpload(input, options) {
  const checkpointPath = resolve(input.resumePath);
  const details = await lstat(checkpointPath);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error("Resume file must be a regular file");
  const state = JSON.parse(await readFile(checkpointPath, "utf8"));
  if (state?.version !== 1 || !state?.upload || !["media", "r2"].includes(state.provider)
    || !["upload", "complete"].includes(state.phase) || typeof state.filePath !== "string") {
    throw new Error("Resume file is invalid or does not contain a supported upload");
  }
  if (state.phase !== "complete") {
    const filePath = resolve(input.filePath || state.filePath);
    if (filePath !== state.filePath) throw new Error("Resume file belongs to a different local file path");
    const fileInfo = await regularFileInfo(filePath);
    if (fileInfo.size !== state.fileSize || fileInfo.mtimeMs !== state.fileMtimeMs) {
      throw new Error("The local file changed after this upload started; choose the original unchanged file to resume");
    }
    await transferBytes(state.upload, filePath, state.fileSize, state.file.mimeType, options);
    if (state.complete) {
      state.phase = "complete";
      await writeCheckpoint(checkpointPath, state);
    }
  }
  if (state.complete) await executeAction(state.complete, actionContext(state), options);
  await rm(checkpointPath, { force: true });
  if (state.compressedDirectory) await rm(state.compressedDirectory, { recursive: true, force: true });
  return {
    provider: state.provider,
    uploadedBytes: state.fileSize,
    protocol: state.upload.protocol,
    status: "complete",
  };
}

async function uploadTus(uploadUrl, filePath, fileSize, options, extraHeaders = {}) {
  let offset = await getTusOffset(uploadUrl, options.fetchImpl ?? fetch, extraHeaders);
  reportProgress(offset, fileSize, options);
  while (offset < fileSize) {
    const end = Math.min(offset + TUS_CHUNK_BYTES, fileSize);
    let completed = false;
    let lastError;
    for (let attempt = 0; attempt < 6 && !completed; attempt += 1) {
      try {
        const response = await (options.fetchImpl ?? fetch)(uploadUrl, {
          method: "PATCH",
          headers: {
            ...extraHeaders,
            "Tus-Resumable": "1.0.0",
            "Upload-Offset": String(offset),
            "Content-Type": "application/offset+octet-stream",
            "Content-Length": String(end - offset),
          },
          body: createReadStream(filePath, { start: offset, end: end - 1 }),
          duplex: "half",
        });
        if (response.status === 204) {
          const nextOffset = Number(response.headers.get("Upload-Offset"));
          if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset || nextOffset > fileSize) {
            throw new Error("Media TUS server returned an invalid upload offset");
          }
          offset = nextOffset;
          completed = true;
          reportProgress(offset, fileSize, options);
          continue;
        }
        const error = new Error(`Media TUS upload failed (HTTP ${response.status})`);
        if (response.status >= 400 && response.status < 500 && response.status !== 409) throw error;
        lastError = error;
      } catch (error) {
        if (error instanceof Error && /^Media TUS upload failed \(HTTP 4/.test(error.message) && !error.message.includes("HTTP 409)")) throw error;
        lastError = error;
      }

      if (!completed) {
        if (attempt < 5) {
          await delay([0, 1000, 3000, 5000, 10000, 20000][attempt]);
          offset = await getTusOffset(uploadUrl, options.fetchImpl ?? fetch, extraHeaders);
          if (offset >= end) {
            completed = true;
            reportProgress(offset, fileSize, options);
          }
        }
      }
    }
    if (!completed) throw new Error(`TUS upload paused and can be resumed; ${lastError instanceof Error ? lastError.message : "network request failed"}`);
  }
}

async function getTusOffset(uploadUrl, fetchImpl, extraHeaders = {}) {
  const response = await fetchImpl(uploadUrl, { method: "HEAD", headers: { ...extraHeaders, "Tus-Resumable": "1.0.0" } });
  if (!response.ok) throw new Error(`Unable to resume TUS upload (HTTP ${response.status})`);
  const offset = Number(response.headers.get("Upload-Offset"));
  const length = Number(response.headers.get("Upload-Length"));
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < offset) {
    throw new Error("TUS server returned invalid upload status headers");
  }
  return offset;
}

async function uploadMultipart(uploadUrl, filePath, fileName, mimeType, fileSize, options, extraHeaders = {}) {
  const boundary = `----WorkspaceUpload${randomUUID().replaceAll("-", "")}`;
  const safeName = fileName.replace(/[\r\n"\\]/g, "_");
  const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const suffix = `\r\n--${boundary}--\r\n`;
  const bodyLength = Buffer.byteLength(prefix) + fileSize + Buffer.byteLength(suffix);
  let response;
  try {
    response = await (options.fetchImpl ?? fetch)(uploadUrl, {
      method: "POST",
      headers: { ...extraHeaders, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(bodyLength) },
      body: Readable.from((async function* streamBody() {
        yield prefix;
        for await (const chunk of createReadStream(filePath)) yield chunk;
        yield suffix;
      })()),
      duplex: "half",
    });
  } catch {
    throw new Error("Direct upload failed and cannot be resumed; the upload must be restarted.");
  }
  if (!response.ok) throw new Error(`Media direct upload failed (HTTP ${response.status})`);
  reportProgress(fileSize, fileSize, options);
}

async function uploadPut(uploadUrl, filePath, fileSize, options, extraHeaders = {}) {
  let response;
  try {
    response = await (options.fetchImpl ?? fetch)(uploadUrl, {
      method: "PUT",
      headers: { ...extraHeaders, "Content-Length": String(fileSize) },
      body: createReadStream(filePath),
      duplex: "half",
    });
  } catch {
    throw new Error("Signed R2 upload failed; this single PUT cannot be resumed and must be restarted.");
  }
  if (!response.ok) throw new Error(`Signed R2 upload failed (HTTP ${response.status})`);
  reportProgress(fileSize, fileSize, options);
}

async function readUploadDescriptor(requestPath) {
  const requestFile = resolve(requestPath);
  const details = await lstat(requestFile);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error("Upload descriptor path must be a regular file");
  let descriptor;
  try {
    descriptor = JSON.parse(await readFile(requestFile, "utf8"));
  } catch (error) {
    throw new Error(`Could not read upload descriptor JSON: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  if (descriptor?.version !== 1 || !["media", "r2"].includes(descriptor.provider)) {
    throw new Error('Upload descriptor must have version 1 and provider "media" or "r2"');
  }
  return descriptor;
}

async function prepareUpload(descriptor, file, options) {
  if (!descriptor.prepare) return { upload: { ...descriptor }, prepareResult: undefined };
  const action = descriptor.prepare.transport === "http"
    ? { ...descriptor.prepare, body: { ...(descriptor.prepare.body ?? {}), ...file } }
    : descriptor.prepare;
  const prepareResult = await executeAction(action, { file }, options);
  const mapped = descriptor.prepare.result
    ? resolveTemplate(descriptor.prepare.result, { file, prepare: prepareResult })
    : prepareResult;
  if (!mapped || typeof mapped !== "object" || Array.isArray(mapped)) throw new Error("Upload preparation did not return an upload descriptor object");
  return {
    upload: { ...mapped, provider: descriptor.provider },
    prepareResult,
  };
}

async function executeAction(action, context, options) {
  if (!action || typeof action !== "object") throw new Error("Upload action must be an object");
  if (action.transport === "mcp") {
    if (typeof action.tool !== "string" || !action.tool) throw new Error("MCP upload action requires a tool name");
    if (!options.store) throw new Error("Sign in with `frontier-workspace auth login` before using an MCP upload descriptor");
    const argumentsValue = resolveTemplate(action.arguments ?? {}, context);
    const result = await callMcpTool(options.store, action.tool, argumentsValue, options);
    return mcpToolPayload(result);
  }
  if (action.transport === "http") {
    if (typeof action.url !== "string" || !action.url) throw new Error("HTTP upload action requires a URL");
    const method = action.method ?? "POST";
    if (method !== "POST") throw new Error("HTTP upload action method must be POST");
    const body = resolveTemplate(action.body ?? {}, context);
    const response = await (options.fetchImpl ?? fetch)(action.url, {
      method,
      headers: { ...(action.headers ?? {}), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Upload action failed (HTTP ${response.status})`);
    try {
      return await response.json();
    } catch {
      throw new Error("Upload endpoint returned invalid JSON");
    }
  }
  throw new Error('Upload action transport must be "mcp" or "http"');
}

function resolveTemplate(value, context) {
  if (Array.isArray(value)) return value.map((item) => resolveTemplate(item, context));
  if (!value || typeof value !== "object") return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "$file") return readPath(context.file, value.$file);
  if (keys.length === 1 && keys[0] === "$prepare") return readPath(context.prepare, value.$prepare);
  if (keys.length === 1 && keys[0] === "$path") return readPath(context.prepare, value.$path);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplate(item, context)]));
}

function readPath(value, path) {
  if (typeof path !== "string" || !path) throw new Error("Upload descriptor field mapping must be a non-empty path");
  return path.split(".").reduce((current, part) => {
    if (!current || typeof current !== "object" || !(part in current)) throw new Error(`Upload descriptor mapping path was not found: ${path}`);
    return current[part];
  }, value);
}

function actionContext(state) {
  return { file: state.file, prepare: state.prepareResult };
}

async function writeCheckpoint(checkpointPath, state, create = false) {
  await writeFile(checkpointPath, `${JSON.stringify(state)}\n`, {
    flag: create ? "wx" : "w",
    mode: 0o600,
  });
  if (process.platform !== "win32") await chmod(checkpointPath, 0o600);
}

function validateUploadDescriptor(upload, fileSize) {
  if (typeof upload.uploadUrl !== "string" || !upload.uploadUrl) throw new Error("Upload descriptor did not return uploadUrl");
  const allowed = upload.provider === "media" ? ["tus", "post"] : ["put"];
  if (!allowed.includes(upload.protocol)) throw new Error(`Unsupported upload protocol for ${upload.provider}: ${upload.protocol}`);
  if (upload.protocol === "tus" && upload.sizeBytes !== undefined && upload.sizeBytes !== fileSize) {
    throw new Error(`Upload descriptor sizeBytes (${upload.sizeBytes}) does not match local file size (${fileSize})`);
  }
  if (upload.protocol === "tus") assertUploadSize(fileSize);
  if (upload.protocol === "put" && fileSize > MAX_R2_PUT_BYTES) throw new Error("This CLI supports signed R2 PUT uploads up to 5 GiB; larger R2 uploads require a multipart protocol that is not supported yet");
}

async function compressVideo(inputPath, ffmpegBin, options) {
  const checkpointRoot = await ensurePrivateUploadDirectory(options.home ?? homedir());
  const directory = join(checkpointRoot, randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const outputPath = join(directory, "compressed.mp4");
  const command = ffmpegBin || process.env.FFMPEG_PATH || "ffmpeg";
  await new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      "-i", inputPath,
      "-map", "0:v:0", "-map", "0:a?",
      "-vf", "scale='min(1920,iw)':-2",
      "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outputPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-3000); });
    child.once("error", (error) => {
      rejectProcess(error.code === "ENOENT"
        ? new Error(`${ffmpegMissingGuide()} Set FFMPEG_PATH or pass --ffmpeg-bin after installation.`)
        : error);
    });
    child.once("close", (code) => {
      if (code === 0) resolveProcess();
      else rejectProcess(new Error(`FFmpeg compression failed${stderr.trim() ? `: ${stderr.trim()}` : ` (exit ${code})`}`));
    });
  }).catch(async (error) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  return { directory, filePath: outputPath };
}

async function regularFileInfo(filePath) {
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Video path must be a regular file: ${filePath}`);
  return { size: details.size, mtimeMs: details.mtimeMs };
}

async function ensurePrivateUploadDirectory(home) {
  const directory = join(home, ".workspace", "uploads");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Workspace upload checkpoint directory is not a regular directory");
  if (process.platform !== "win32") await chmod(directory, 0o700);
  return directory;
}

function assertUploadSize(size) {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) {
    throw new Error("Media TUS uploads must be smaller than 30 GB");
  }
}

function ffmpegMissingGuide() {
  if (process.platform === "darwin") return "FFmpeg was not found. Install it with `brew install ffmpeg` or download it from https://ffmpeg.org/download.html.";
  if (process.platform === "win32") return "FFmpeg was not found. Install it with `winget install Gyan.FFmpeg` or download it from https://ffmpeg.org/download.html.";
  return "FFmpeg was not found. Install it with your package manager (for example, `sudo apt install ffmpeg` on Debian/Ubuntu) or download it from https://ffmpeg.org/download.html.";
}

function reportProgress(bytesUploaded, bytesTotal, options) {
  const percentage = bytesTotal ? Math.min(100, Math.floor((bytesUploaded / bytesTotal) * 100)) : 100;
  writeLine(options.stderr, `Upload progress: ${percentage}% (${formatBytes(bytesUploaded)} / ${formatBytes(bytesTotal)})`);
}

function formatBytes(bytes) {
  return `${(bytes / (1024 ** 3)).toFixed(2)} GiB`;
}

function writeLine(stream, value) {
  stream?.write(`${value}\n`);
}
