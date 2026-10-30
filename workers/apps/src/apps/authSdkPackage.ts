import { WORKSPACE_AUTH_SDK_VERSION } from "./authSdk";
import { WORKSPACE_AUTH_SDK_PACKAGE_BASE64 } from "./authSdkPackageData";

const authSdkTarball = decodeBase64(WORKSPACE_AUTH_SDK_PACKAGE_BASE64);

export function authSdkPackageResponse() {
  return new Response(authSdkTarball, {
    headers: {
      "Cache-Control": "public, max-age=3600, immutable",
      "Content-Disposition": `attachment; filename="workspace-auth-${WORKSPACE_AUTH_SDK_VERSION}.tgz"`,
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
