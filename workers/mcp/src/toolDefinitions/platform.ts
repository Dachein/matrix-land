import { type McpToolDefinition } from "./shared.ts";

export const platformToolDefinitions: McpToolDefinition[] = [
{
    name: "ping_who_am_i",
    description: "Always call this first to diagnose Workspace MCP setup, connection, authentication, CLI upgrade or reinstall, and guided-use issues. Returns the authenticated account, connection and server metadata, structured checks, and the required recovery action without credential material. If authorization prevents the call, follow the reauthentication details in the 401 response.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
{
    name: "models_list",
    description: "List the Workspace LLM gateway models available to this account, with tri-state capability and endpoint support, context limits, and pricing. Capability values are supported, unsupported, or unknown; unknown means the gateway has not declared the value and must never be read as unsupported. Read this before choosing, explaining, or configuring a model in any client.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
{
    name: "image_generation",
    description: "Generate or edit images through Cloudflare with GPT Image 2.5 Flare (default, fast everyday generation) or Sunburst (precise editing). Returns a private seven-day image URL. Independent of LiteLLM. Use opaque or auto backgrounds.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 8000 },
        model: { type: "string", enum: ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"], default: "gpt-image-2.5-flare" },
        images: { type: "array", maxItems: 16, items: { type: "string", maxLength: 17000000 }, description: "Up to sixteen reference images for editing with either model. Each is a public HTTPS image URL or base64 data image URL, at most 12 MB decoded each and 20 MB total." },
        quality: { type: "string", enum: ["low", "medium", "high", "xhigh", "max", "auto"], default: "medium", description: "Native GPT Image 2.5 quality setting, forwarded unchanged to Cloudflare." },
        size: { type: "string", enum: ["1024x1024", "1024x1536", "1536x1024", "auto"], default: "1024x1024" },
        background: { type: "string", enum: ["opaque", "auto"] },
        outputFormat: { type: "string", enum: ["png", "webp", "jpeg"], default: "png" }
      }
    }
  },
{
    name: "video_generation",
    description: "Generate a MiniMax H3 video through Cloudflare Unified Billing. This is an independent public capability and does not call LiteLLM.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 8000 },
        duration: { type: "integer", minimum: 4, maximum: 15, default: 5 },
        resolution: { type: "string", enum: ["768P", "2K"], default: "768P" },
        ratio: { type: "string", enum: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], default: "16:9" },
        images: {
          type: "array",
          maxItems: 4,
          description: "Optional public HTTPS first frame, last frame, or reference images.",
          items: {
            type: "object",
            required: ["url", "role"],
            additionalProperties: false,
            properties: {
              url: { type: "string", maxLength: 2048 },
              role: { type: "string", enum: ["first_frame", "last_frame", "reference_image"] }
            }
          }
        }
      }
    }
  },
{
    name: "web_search",
    description: "Search the public web with Exa through Cloudflare AI Gateway credits. Prefer primary regulator, legislation, tax authority and issuer sources for financial research. Results are leads; use web_reader for source evidence.",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 5 }
      }
    }
  },
{
    name: "web_reader",
    description: "Read a public HTTPS webpage or PDF and return bounded Markdown or text. Private and local network targets are blocked.",
    inputSchema: {
      type: "object",
      required: ["url"],
      additionalProperties: false,
      properties: { url: { type: "string", maxLength: 2048 } }
    }
  },
{
    name: "whisper_asr",
    description: "Transcribe speech from a public HTTPS audio URL with Cloudflare Workers AI Whisper Large V3 Turbo. Specify language (e.g. zh for Chinese, en for English) when known; omit to auto-detect. initialPrompt is optional terminology context, not an expected transcript.",
    inputSchema: {
      type: "object",
      required: ["audioUrl"],
      additionalProperties: false,
      properties: {
        audioUrl: { type: "string", maxLength: 2048 },
        task: { type: "string", enum: ["transcribe"], default: "transcribe" },
        language: { type: "string", minLength: 2, maxLength: 3, pattern: "^[a-zA-Z]{2,3}$", description: "Language code such as zh or en; omit for automatic detection." },
        initialPrompt: { type: "string", maxLength: 2000, description: "Optional names or domain terminology to aid recognition; do not supply an expected transcript." }
      }
    }
  },
{
    name: "audio_tts",
    description: "Generate speech with MiniMax Speech 2.8 Turbo through Cloudflare Workers AI. Returns a persistent audio URL.",
    inputSchema: {
      type: "object",
      required: ["text"],
      additionalProperties: false,
      properties: {
        text: { type: "string", minLength: 1, maxLength: 10_000 },
        voiceId: { type: "string", minLength: 1, maxLength: 120, default: "English_expressive_narrator" },
        speed: { type: "number", minimum: 0.5, maximum: 2, default: 1 },
        volume: { type: "number", minimum: 0, maximum: 10, default: 1 },
        pitch: { type: "integer", minimum: -12, maximum: 12, default: 0 },
        emotion: { type: "string", enum: ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "fluent"] },
        format: { type: "string", enum: ["mp3", "flac", "wav"], default: "mp3" }
      }
    }
  },
{
    name: "jev",
    description: "Evaluate structured state with Cloudflare Workers AI JEV. Questions use noul, choice, or score criteria and return calibrated structured answers.",
    inputSchema: {
      type: "object",
      required: ["state", "questions"],
      additionalProperties: false,
      properties: {
        state: { description: "Text or JSON object containing the state to evaluate." },
        questions: {
          type: "object",
          description: "Named evaluation questions. Each value requires type, instructions, and criteria.",
          additionalProperties: {
            type: "object",
            required: ["type", "instructions"],
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["noul", "choice", "score"] },
              instructions: { type: "string", minLength: 1, maxLength: 2000 },
              criteria: { description: "For noul/choice use a label-to-description object; for score use an ordered string array." }
            }
          }
        }
      }
    }
  }
];
