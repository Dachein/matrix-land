import { missingConfiguration } from "../../../src/shared/requiredConfiguration.ts";
import { mateArtifactOwnerPath, putMateArtifact } from "../../../src/shared/mateArtifacts.ts";
import { CloudflareWebSearchError, searchCloudflareExa } from "../../../src/shared/cloudflareWebSearch.ts";
import { HttpError, type Env, type Principal } from "./types.ts";
import { runImageModel } from "./imageModels.ts";

const VIDEO_MODEL = "minimax/h3";
const TTS_MODEL = "minimax/speech-2.8-turbo";
const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
const JEV_MODEL = "typesafe/jev";
const SEARCH_LIMIT_MAX = 10;
const WEB_BODY_MAX_BYTES = 3_000_000;
const WEB_TEXT_MAX_CHARS = 100_000;
const AUDIO_MAX_BYTES = 25_000_000;

export async function generateImage(env: Env, args: Record<string, unknown>, principal: Principal) {
  requireAi(env);
  if (!env.MATE_ARTIFACTS) throw new HttpError(503, "mate_artifact_storage_not_configured");
  const prompt = requiredText(args.prompt, "image_prompt_required", 8_000);
  const quality = enumValue(args.quality, ["low", "medium", "high", "xhigh", "max", "auto"], "medium");
  const size = enumValue(args.size, ["1024x1024", "1024x1536", "1536x1024", "auto"], "1024x1024");
  const background = optionalEnum(args.background, ["transparent", "opaque", "auto"]);
  const outputFormat = optionalEnum(args.outputFormat, ["png", "webp", "jpeg"]);
  const result = await runImageModel(env, { ...args, background, outputFormat }, prompt, size, quality);
  const stored = await persistGeneratedMedia(env, principal, result.response, "image", result.format);
  return {
    model: result.model,
    imageUrl: stored.url,
    storageKey: stored.storageKey,
    artifactId: stored.artifactId,
    expiresAt: stored.expiresAt,
    sizeBytes: stored.sizeBytes,
    quality,
    size,
    width: result.width,
    height: result.height,
    outputFormat: result.format,
    usage: result.usage ?? null
  };
}

export async function generateVideo(env: Env, args: Record<string, unknown>, principal: Principal) {
  requireAi(env);
  const prompt = requiredText(args.prompt, "video_prompt_required", 8_000);
  const duration = integer(args.duration, 5, 4, 15, "video_duration_invalid");
  const resolution = enumValue(args.resolution, ["768P", "2K"], "768P");
  const ratio = enumValue(args.ratio, ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], "16:9");
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const item of imageRoleInputs(args.images)) {
    content.push({
      type: "image_url",
      image_url: { url: requirePublicHttpsUrl(item.url).toString() },
      role: item.role
    });
  }
  const result = await env.AI!.run(VIDEO_MODEL as never, {
    content,
    duration,
    resolution,
    ratio
  } as never) as unknown as Record<string, unknown>;
  const task = record(result.task) ?? record(record(result.result)?.task);
  const upstreamUrl = text(record(task?.content)?.url);
  if (!task || text(task.status) !== "succeeded" || !upstreamUrl) {
    throw new HttpError(502, "video_generation_incomplete", `Video generation did not complete (${text(task?.status) || "unknown"}).`);
  }
  const stored = await persistGeneratedMedia(env, principal, upstreamUrl, "video", "mp4");
  return {
    model: VIDEO_MODEL,
    taskId: text(task.id) || null,
    status: "completed",
    videoUrl: stored.url,
    storageKey: stored.storageKey,
    artifactId: stored.artifactId,
    expiresAt: stored.expiresAt,
    sizeBytes: stored.sizeBytes,
    duration: Number(task.duration) || duration,
    resolution: text(task.resolution) || resolution,
    ratio: text(task.ratio) || ratio,
    usage: task.usage ?? null
  };
}

export async function searchWeb(env: Env, args: Record<string, unknown>) {
  const query = requiredText(args.query, "web_search_query_required", 500);
  const limit = integer(args.limit, 5, 1, SEARCH_LIMIT_MAX, "web_search_limit_invalid");
  try {
    return await searchCloudflareExa(env.AI, query, limit);
  } catch (error) {
    if (error instanceof CloudflareWebSearchError) throw new HttpError(error.status, error.code);
    throw error;
  }
}

export async function readWeb(env: Env, args: Record<string, unknown>) {
  const requested = requiredText(args.url, "web_reader_url_required", 2_048);
  let url = requirePublicHttpsUrl(requested);
  let response: Response | undefined;
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/pdf,text/plain,application/json,application/xml;q=0.9,*/*;q=0.2",
        "User-Agent": "Workspace-Pass-MCP/1.0"
      },
      redirect: "manual"
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location || redirect === 4) throw new HttpError(502, "web_reader_redirect_invalid");
    url = requirePublicHttpsUrl(new URL(location, url).toString());
  }
  if (!response?.ok) throw new HttpError(response?.status === 404 ? 404 : 502, "web_reader_upstream_failed");
  const bytes = await readLimited(response, WEB_BODY_MAX_BYTES, "web_reader_body_too_large");
  const contentType = mediaType(response.headers.get("content-type"));
  let content: string;
  let format: "text" | "markdown";
  if (/^(text\/plain|application\/(json|xml))$/.test(contentType)) {
    content = new TextDecoder().decode(bytes);
    format = "text";
  } else if (contentType === "text/html" || contentType === "application/xhtml+xml" || contentType === "application/pdf") {
    requireAi(env);
    const converted = await env.AI!.toMarkdown({
      blob: new Blob([bytes], { type: contentType }),
      name: fileName(url, contentType)
    }, {
      conversionOptions: {
        html: contentType.includes("html") ? { hostname: url.origin } : undefined,
        pdf: contentType === "application/pdf" ? { metadata: false } : undefined
      }
    });
    if (converted.format === "error") throw new HttpError(502, "web_reader_conversion_failed");
    content = converted.data;
    format = "markdown";
  } else {
    throw new HttpError(415, "web_reader_content_type_unsupported");
  }
  const normalized = content.trim();
  return {
    url: url.toString(),
    fetchedAt: new Date().toISOString(),
    contentType,
    format,
    content: normalized.slice(0, WEB_TEXT_MAX_CHARS),
    truncated: normalized.length > WEB_TEXT_MAX_CHARS
  };
}

export async function transcribeAudio(env: Env, args: Record<string, unknown>) {
  requireAi(env);
  const audioUrl = requirePublicHttpsUrl(requiredText(args.audioUrl, "audio_url_required", 2_048));
  const language = optionalText(args.language, 3)?.toLowerCase();
  if (language && !/^[a-z]{2,3}$/.test(language)) throw new HttpError(400, "audio_language_invalid");
  const initialPrompt = optionalText(args.initialPrompt, 2_000);
  const task = enumValue(args.task, ["transcribe"], "transcribe");
  const response = await fetch(audioUrl, { redirect: "manual" });
  if ([301, 302, 303, 307, 308].includes(response.status)) throw new HttpError(502, "audio_redirect_not_allowed");
  if (!response.ok) throw new HttpError(502, "audio_fetch_failed");
  const bytes = await readLimited(response, AUDIO_MAX_BYTES, "audio_too_large");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  const result = await env.AI!.run(WHISPER_MODEL as never, {
    audio: btoa(binary),
    task,
    ...(language ? { language } : {}),
    ...(initialPrompt ? { initial_prompt: initialPrompt } : {})
  } as never) as unknown as Record<string, unknown>;
  return {
    model: WHISPER_MODEL,
    task,
    language: record(result.transcription_info)?.language ?? result.language ?? null,
    text: text(result.text),
    transcriptionInfo: result.transcription_info ?? null,
    segments: result.segments ?? [],
    vtt: result.vtt ?? null
  };
}

export async function generateSpeech(env: Env, args: Record<string, unknown>, principal: Principal) {
  requireAi(env);
  const inputText = requiredText(args.text, "tts_text_required", 10_000);
  const voiceId = requiredText(args.voiceId ?? "English_expressive_narrator", "tts_voice_id_required", 120);
  const speed = finiteNumber(args.speed, 1, 0.5, 2, "tts_speed_invalid");
  const volume = finiteNumber(args.volume, 1, 0, 10, "tts_volume_invalid");
  const pitch = integer(args.pitch, 0, -12, 12, "tts_pitch_invalid");
  const emotion = optionalEnum(args.emotion, ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "fluent"]);
  const format = enumValue(args.format, ["mp3", "flac", "wav"], "mp3");
  const result = await env.AI!.run(TTS_MODEL as never, {
    text: inputText,
    voice_id: voiceId,
    speed,
    volume,
    pitch,
    format,
    ...(emotion ? { emotion } : {})
  } as never) as unknown as Record<string, unknown>;
  const payload = record(result.result) ?? result;
  const upstreamUrl = text(payload.audio);
  if (!upstreamUrl) throw new HttpError(502, "tts_generation_missing_audio");
  const extension = format;
  const stored = await persistGeneratedMedia(env, principal, upstreamUrl, "audio", extension);
  return {
    model: TTS_MODEL,
    voiceId,
    format,
    audioUrl: stored.url,
    storageKey: stored.storageKey,
    artifactId: stored.artifactId,
    expiresAt: stored.expiresAt,
    sizeBytes: stored.sizeBytes,
    contentType: audioContentType(format),
    usage: result.usage ?? null
  };
}

export async function callJev(env: Env, args: Record<string, unknown>) {
  requireAi(env);
  const state = args.state;
  if (typeof state !== "string" && !record(state)) throw new HttpError(400, "jev_state_required");
  const questions = record(args.questions);
  if (!questions || Object.keys(questions).length === 0) throw new HttpError(400, "jev_questions_required");
  if (Object.keys(questions).length > 64) throw new HttpError(400, "jev_questions_too_many");
  for (const [name, value] of Object.entries(questions)) validateJevQuestion(name, value);

  const rawResult = await env.AI!.run(JEV_MODEL as never, { state, questions } as never) as unknown;
  const result = await normalizeJevResult(rawResult);
  const answers = record(result.answers);
  if (!answers) throw new HttpError(502, "jev_response_invalid");
  return {
    provider: "cloudflare_ai",
    model: text(result.model) || JEV_MODEL,
    answers,
    usage: record(result.usage) ?? null
  };
}

async function normalizeJevResult(value: unknown): Promise<Record<string, unknown>> {
  let payload: unknown = value;
  if (payload instanceof Response) payload = await payload.json().catch(() => undefined);
  if (typeof payload === "string") payload = JSON.parse(payload);
  let output = record(payload);
  if (!output) throw new HttpError(502, "jev_response_invalid");
  output = record(output.result) ?? record(output.response) ?? output;
  if (typeof output.response === "string") {
    const parsed = JSON.parse(output.response);
    output = record(parsed) ?? output;
  }
  return output;
}

function validateJevQuestion(name: string, value: unknown) {
  if (!name.trim() || name.length > 120) throw new HttpError(400, "jev_question_name_invalid");
  const question = record(value);
  if (!question) throw new HttpError(400, "jev_question_invalid");
  const type = enumValue(question.type, ["noul", "choice", "score"], "noul");
  requiredText(question.instructions, "jev_question_instructions_required", 2_000);
  if (type === "score") {
    const criteria = stringArray(question.criteria, 20);
    if (criteria.length < 2) throw new HttpError(400, "jev_score_criteria_invalid");
    return;
  }
  if (type === "noul" && question.criteria === undefined) return;
  const criteria = record(question.criteria);
  if (!criteria) throw new HttpError(400, "jev_question_criteria_invalid");
  const entries = Object.entries(criteria);
  if (type === "noul" && (!Object.hasOwn(criteria, "true") || !Object.hasOwn(criteria, "false"))) {
    throw new HttpError(400, "jev_noul_criteria_invalid");
  }
  if (type === "choice" && (entries.length < 2 || entries.length > 50)) {
    throw new HttpError(400, "jev_choice_criteria_invalid");
  }
  for (const [key, description] of entries) {
    if (!key.trim() || !text(description).trim()) throw new HttpError(400, "jev_question_criteria_invalid");
  }
}

function requireAi(env: Env) {
  if (!env.AI) throw new HttpError(503, "workers_ai_not_configured");
}

function requiredText(value: unknown, code: string, max: number) {
  const output = text(value).trim();
  if (!output) throw new HttpError(400, code);
  if (output.length > max) throw new HttpError(400, `${code}_too_long`);
  return output;
}

function optionalText(value: unknown, max: number) {
  const output = text(value).trim();
  if (!output) return undefined;
  if (output.length > max) throw new HttpError(400, "value_too_long");
  return output;
}

function text(value: unknown) { return typeof value === "string" ? value : ""; }
function record(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }

function integer(value: unknown, fallback: number, min: number, max: number, code: string) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new HttpError(400, code);
  return parsed;
}

function enumValue<const T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const candidate = value === undefined ? fallback : text(value);
  if (!allowed.includes(candidate as T)) throw new HttpError(400, "unsupported_option");
  return candidate as T;
}

function optionalEnum<const T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  return enumValue(value, allowed, allowed[0]!);
}

function stringArray(value: unknown, max: number) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string")) {
    throw new HttpError(400, "image_inputs_invalid");
  }
  return value as string[];
}

function imageRoleInputs(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw new HttpError(400, "video_image_inputs_invalid");
  return value.map((entry) => {
    const item = record(entry);
    const url = text(item?.url);
    const role = text(item?.role);
    if (!url || !["first_frame", "last_frame", "reference_image"].includes(role)) {
      throw new HttpError(400, "video_image_inputs_invalid");
    }
    return { url, role };
  });
}

function requirePublicHttpsUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, "public_https_url_required"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new HttpError(400, "public_https_url_required");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.includes(":")) {
    throw new HttpError(403, "private_address_blocked");
  }
  const octets = hostname.split(".").map(Number);
  if (octets.length === 4 && octets.every(Number.isInteger)) {
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      throw new HttpError(403, "private_address_blocked");
    }
  }
  url.hash = "";
  return url;
}

async function readLimited(response: Response, limit: number, code: string) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, code);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new HttpError(413, code);
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function mediaType(value: string | null) { return (value ?? "application/octet-stream").split(";", 1)[0]!.trim().toLowerCase(); }
function fileName(url: URL, contentType: string) {
  const candidate = decodeURIComponent(url.pathname.split("/").at(-1) || "document").slice(0, 160);
  if (candidate.includes(".")) return candidate;
  return `${candidate || "document"}${contentType === "application/pdf" ? ".pdf" : ".html"}`;
}

async function persistGeneratedMedia(env: Env, principal: Principal, upstreamUrl: string | Response, kind: "image" | "video" | "audio", extension: string) {
  if (!env.MATE_ARTIFACTS) throw new HttpError(503, "mate_artifact_storage_not_configured");
  const response = upstreamUrl instanceof Response ? upstreamUrl : await fetch(requirePublicHttpsUrl(upstreamUrl), { redirect: "manual" });
  if ([301, 302, 303, 307, 308].includes(response.status)) throw new HttpError(502, "generated_media_redirect_not_allowed");
  if (!response.ok || !response.body) throw new HttpError(502, "generated_media_fetch_failed");
  const contentType = mediaType(response.headers.get("content-type"));
  if (kind === "image" && !contentType.startsWith("image/")) throw new HttpError(502, "generated_media_type_invalid");
  if (kind === "video" && !contentType.startsWith("video/")) throw new HttpError(502, "generated_media_type_invalid");
  if (kind === "audio" && !contentType.startsWith("audio/")) throw new HttpError(502, "generated_media_type_invalid");
  const suffix = extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || (kind === "video" ? "mp4" : kind === "audio" ? "mp3" : "png");
  const owner = {
    orgId: principal.orgId || "example-org",
    userId: principal.sub,
    mateId: principal.mateId || "direct"
  };
  const stored = await putMateArtifact(env.MATE_ARTIFACTS, owner, {
    // Decoded images are newly constructed responses; R2 needs a known-length
    // buffer rather than an arbitrary stream. Fetched video/audio can stream.
    body: upstreamUrl instanceof Response ? await response.arrayBuffer() : response.body,
    fileName: `generated-${kind}.${suffix}`,
    kind,
    mediaType: contentType
  });
  const resource = (env.MCP_RESOURCE_URL ?? missingConfiguration("MCP_RESOURCE_URL")).replace(/\/$/, "");
  return {
    artifactId: stored.artifactId,
    expiresAt: stored.expiresAt,
    storageKey: stored.key,
    sizeBytes: stored.sizeBytes,
    url: `${resource}/artifacts/${mateArtifactOwnerPath(owner)}/${stored.artifactId}?token=${stored.previewToken}`
  };
}

function audioContentType(format: string) {
  if (format === "wav") return "audio/wav";
  if (format === "flac") return "audio/flac";
  return "audio/mpeg";
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number, code: string) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new HttpError(400, code);
  return parsed;
}
