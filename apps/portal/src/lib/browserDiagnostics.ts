export type BrowserDiagnostics = {
  architecture: string;
  availableScreen: string;
  browser: string;
  colorDepth: string;
  colorScheme: "dark" | "light";
  connection: string;
  cookiesEnabled: boolean;
  cpuCores: string;
  deviceMemory: string;
  devicePixelRatio: string;
  deviceType: "desktop" | "mobile" | "tablet";
  displayMode: string;
  forcedColors: boolean;
  generatedAt: string;
  gpu: string;
  languages: string;
  online: boolean;
  operatingSystem: string;
  orientation: string;
  physicalScreenEstimate: string;
  platform: string;
  reducedMotion: boolean;
  screen: string;
  secureContext: boolean;
  storage: string;
  timezone: string;
  touchPoints: string;
  userAgent: string;
  viewport: string;
  visualViewport: string;
};

type NavigatorUAData = {
  brands?: BrowserBrand[];
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
  mobile?: boolean;
  platform?: string;
};

type BrowserBrand = {
  brand: string;
  version: string;
};

type NetworkInformation = {
  downlink?: number;
  effectiveType?: string;
  rtt?: number;
  saveData?: boolean;
  type?: string;
};

export async function collectBrowserDiagnostics(): Promise<BrowserDiagnostics> {
  const userAgent = navigator.userAgent;
  const uaData = (navigator as Navigator & { userAgentData?: NavigatorUAData }).userAgentData;
  const highEntropy = await readHighEntropyValues(uaData);
  const devicePixelRatio = window.devicePixelRatio || 1;
  const visualViewport = window.visualViewport;
  const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  const storage = await readStorageEstimate();

  return {
    architecture: formatArchitecture(highEntropy),
    availableScreen: formatDimensions(screen.availWidth, screen.availHeight, "CSS px"),
    browser: detectBrowser(userAgent, readBrands(highEntropy.fullVersionList) ?? uaData?.brands),
    colorDepth: screen.colorDepth ? `${screen.colorDepth}-bit` : "",
    colorScheme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    connection: formatConnection(connection),
    cookiesEnabled: navigator.cookieEnabled,
    cpuCores: navigator.hardwareConcurrency ? String(navigator.hardwareConcurrency) : "",
    deviceMemory: readDeviceMemory(),
    devicePixelRatio: `${formatNumber(devicePixelRatio)}×`,
    deviceType: detectDeviceType(userAgent, uaData?.mobile),
    displayMode: detectDisplayMode(),
    forcedColors: window.matchMedia("(forced-colors: active)").matches,
    generatedAt: new Date().toISOString(),
    gpu: readGpuRenderer(),
    languages: navigator.languages?.length ? navigator.languages.join(", ") : navigator.language,
    online: navigator.onLine,
    operatingSystem: detectOperatingSystem(userAgent, uaData?.platform, readString(highEntropy.platformVersion)),
    orientation: screen.orientation?.type ?? "",
    physicalScreenEstimate: formatDimensions(
      Math.round(screen.width * devicePixelRatio),
      Math.round(screen.height * devicePixelRatio),
      "device px"
    ),
    platform: [uaData?.platform || navigator.platform, readString(highEntropy.model)].filter(Boolean).join(" · "),
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    screen: formatDimensions(screen.width, screen.height, "CSS px"),
    secureContext: window.isSecureContext,
    storage,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    touchPoints: String(navigator.maxTouchPoints ?? 0),
    userAgent,
    viewport: formatDimensions(window.innerWidth, window.innerHeight, "CSS px"),
    visualViewport: visualViewport
      ? `${formatDimensions(Math.round(visualViewport.width), Math.round(visualViewport.height), "CSS px")} · ${formatNumber(visualViewport.scale * 100)}%`
      : ""
  };
}

async function readHighEntropyValues(uaData: NavigatorUAData | undefined) {
  if (!uaData?.getHighEntropyValues) {
    return {} as Record<string, unknown>;
  }

  try {
    return await uaData.getHighEntropyValues([
      "architecture",
      "bitness",
      "fullVersionList",
      "model",
      "platformVersion",
      "wow64"
    ]);
  } catch {
    return {} as Record<string, unknown>;
  }
}

function readBrands(value: unknown): BrowserBrand[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const brands = value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const brand = readString((item as Record<string, unknown>).brand);
    const version = readString((item as Record<string, unknown>).version);
    return brand ? [{ brand, version }] : [];
  });

  return brands.length > 0 ? brands : undefined;
}

function detectBrowser(userAgent: string, brands: BrowserBrand[] | undefined) {
  const embeddedBrowser = firstUserAgentMatch(userAgent, [
    [/(?:MicroMessenger)\/([\d.]+)/, "WeChat"],
    [/(?:DingTalk)\/([\d.]+)/, "DingTalk"],
    [/(?:Lark)\/([\d.]+)/, "Lark"]
  ]);

  if (embeddedBrowser) {
    return embeddedBrowser;
  }

  const brandPriority = ["Microsoft Edge", "Google Chrome", "Opera", "Chromium"];
  for (const preferredBrand of brandPriority) {
    const match = brands?.find(({ brand }) => brand.toLowerCase() === preferredBrand.toLowerCase());
    if (match) {
      return joinNameAndVersion(preferredBrand === "Microsoft Edge" ? "Edge" : preferredBrand, match.version);
    }
  }

  return firstUserAgentMatch(userAgent, [
    [/(?:EdgA?|EdgiOS)\/([\d.]+)/, "Edge"],
    [/(?:OPR)\/([\d.]+)/, "Opera"],
    [/(?:FxiOS)\/([\d.]+)/, "Firefox"],
    [/(?:Firefox)\/([\d.]+)/, "Firefox"],
    [/(?:CriOS)\/([\d.]+)/, "Chrome"],
    [/(?:Chrome)\/([\d.]+)/, "Chrome"],
    [/(?:Version)\/([\d.]+).*Safari\//, "Safari"]
  ]) || "";
}

function firstUserAgentMatch(userAgent: string, patterns: Array<[RegExp, string]>) {
  for (const [pattern, name] of patterns) {
    const match = userAgent.match(pattern);
    if (match) {
      return joinNameAndVersion(name, match[1]);
    }
  }

  return "";
}

function detectOperatingSystem(userAgent: string, clientPlatform = "", platformVersion = "") {
  if (clientPlatform) {
    return joinNameAndVersion(clientPlatform, platformVersion === "0.0.0" ? "" : platformVersion);
  }

  const ios = userAgent.match(/(?:CPU (?:iPhone )?OS|iPhone OS) ([\d_]+)/);
  if (ios) {
    return joinNameAndVersion("iOS", ios[1].replaceAll("_", "."));
  }

  const android = userAgent.match(/Android ([\d.]+)/);
  if (android) {
    return joinNameAndVersion("Android", android[1]);
  }

  const windows = userAgent.match(/Windows NT ([\d.]+)/);
  if (windows) {
    const name = windows[1] === "10.0" ? "Windows 10/11" : "Windows";
    return joinNameAndVersion(name, windows[1] === "10.0" ? "" : `NT ${windows[1]}`);
  }

  const chromeOs = userAgent.match(/CrOS [^ ]+ ([\d.]+)/);
  if (chromeOs) {
    return joinNameAndVersion("ChromeOS", chromeOs[1]);
  }

  const macOs = userAgent.match(/Mac OS X ([\d_]+)/);
  if (macOs) {
    return joinNameAndVersion("macOS", macOs[1].replaceAll("_", "."));
  }

  if (/Linux/.test(userAgent)) {
    return "Linux";
  }

  return navigator.platform || "";
}

function detectDeviceType(userAgent: string, clientMobile: boolean | undefined): BrowserDiagnostics["deviceType"] {
  if (
    /iPad|Tablet|PlayBook|Silk/i.test(userAgent)
    || /Macintosh.*Mobile/i.test(userAgent)
    || (/Android/i.test(userAgent) && !/Mobile/i.test(userAgent))
  ) {
    return "tablet";
  }

  return clientMobile || /Mobi|iPhone|iPod|Android/i.test(userAgent) ? "mobile" : "desktop";
}

function formatArchitecture(values: Record<string, unknown>) {
  const architecture = readString(values.architecture);
  const bitness = readString(values.bitness);
  const wow64 = values.wow64 === true ? "WOW64" : "";
  return [architecture, bitness ? `${bitness}-bit` : "", wow64].filter(Boolean).join(" · ");
}

function formatConnection(connection: NetworkInformation | undefined) {
  if (!connection) {
    return "";
  }

  return [
    connection.type || connection.effectiveType,
    typeof connection.downlink === "number" ? `${formatNumber(connection.downlink)} Mbps` : "",
    typeof connection.rtt === "number" ? `${connection.rtt} ms RTT` : "",
    connection.saveData ? "Save-Data" : ""
  ].filter(Boolean).join(" · ");
}

function detectDisplayMode() {
  if (document.fullscreenElement) {
    return "fullscreen";
  }

  if (window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone) {
    return "standalone";
  }

  return "browser";
}

function readGpuRenderer() {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!context) {
      return "";
    }

    const debugInfo = context.getExtension("WEBGL_debug_renderer_info");
    return String(debugInfo
      ? context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      : context.getParameter(context.RENDERER) ?? "");
  } catch {
    return "";
  }
}

async function readStorageEstimate() {
  if (!navigator.storage?.estimate) {
    return "";
  }

  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (typeof quota !== "number") {
      return "";
    }

    return `${formatBytes(usage ?? 0)} / ${formatBytes(quota)}`;
  } catch {
    return "";
  }
}

function readDeviceMemory() {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof memory === "number" ? `${formatNumber(memory)} GB` : "";
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function joinNameAndVersion(name: string, version: string) {
  return [name, version].filter(Boolean).join(" ");
}

function formatDimensions(width: number, height: number, unit: string) {
  return `${width} × ${height} ${unit}`;
}

function formatNumber(value: number) {
  return String(Math.round(value * 100) / 100);
}

function formatBytes(value: number) {
  if (value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${formatNumber(value / 1024 ** unitIndex)} ${units[unitIndex]}`;
}
