import { WORKSPACE_MAIL_SDK_EMBEDDED_VERSION } from "./mailSdkPackageMetadata";
import { WORKSPACE_MAIL_SDK_PACKAGES } from "./mailSdkPackageData";

export function mailSdkPackageResponse(version = WORKSPACE_MAIL_SDK_EMBEDDED_VERSION) {
  const encoded = Object.hasOwn(WORKSPACE_MAIL_SDK_PACKAGES, version) ? WORKSPACE_MAIL_SDK_PACKAGES[version] : undefined;
  if (!encoded) return new Response("Mail SDK version not found", { status: 404 });
  return new Response(decodeBase64(encoded), {
    headers: {
      "Cache-Control": "public, max-age=3600, immutable",
      "Content-Disposition": `attachment; filename="workspace-mail-${version}.tgz"`,
      "Content-Type": "application/gzip"
    }
  });
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
