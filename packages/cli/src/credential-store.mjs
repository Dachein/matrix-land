import { installationOptions, assertCredentialInstallation } from "./installation.mjs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export function createCredentialStore(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const storeKind = env.WORKSPACE_CREDENTIAL_STORE;
  if (storeKind === "keychain") {
    throw new Error("WORKSPACE_CREDENTIAL_STORE=keychain is not supported by Workspace CLI; use file on macOS");
  }
  if (storeKind === "dpapi") {
    throw new Error("WORKSPACE_CREDENTIAL_STORE=dpapi is not supported by Workspace CLI; use file on Windows");
  }
  if (storeKind && storeKind !== "file") {
    throw new Error(`Unsupported WORKSPACE_CREDENTIAL_STORE: ${storeKind}`);
  }
  const installation = installationOptions(options);
  const rootDirectory = platform === "win32"
    ? join(env.APPDATA || home, "Frontier Workspace")
    : join(home, ".frontier-workspace");
  const credentialDirectory = join(rootDirectory, "instances", installation.installationKey);
  const filePath = env.WORKSPACE_CREDENTIAL_PATH ?? join(credentialDirectory, "credentials.json");
  const refreshLockPath = env.WORKSPACE_REFRESH_LOCK_PATH ?? join(credentialDirectory, "oauth-refresh.lock");
  const withRefreshLock = (callback) => withFileLock(refreshLockPath, callback, platform);

  return {
    kind: "private-file",
    filePath, refreshLockPath, installation,
    withRefreshLock,
    async load() {
      try {
        await secureExistingFile(filePath, platform);
        const credential = parseCredential(await readFile(filePath, "utf8"));
        assertCredentialInstallation(credential, installation);
        return credential;
      } catch (error) {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      }
    },
    async save(value) {
      assertCredentialInstallation(value, installation);
      const directory = dirname(filePath);
      await ensurePrivateDirectory(directory, platform);
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await open(temporaryPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        if (platform !== "win32") await chmod(temporaryPath, 0o600);
        await rename(temporaryPath, filePath);
        await secureExistingFile(filePath, platform);
      } finally {
        await handle?.close().catch(() => {});
        await rm(temporaryPath, { force: true });
      }
    },
    async clear() {
      await secureExistingFile(filePath, platform).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      await rm(filePath, { force: true });
    }
  };
}

async function withFileLock(lockPath, callback, platform) {
  await ensurePrivateDirectory(dirname(lockPath), platform);
  const deadline = Date.now() + 15_000;
  const owner = `${process.pid}:${randomUUID()}`;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > 120_000) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for another Workspace session to refresh OAuth");
      await delay(75);
    }
  }
  await handle.writeFile(owner, "utf8");
  try {
    return await callback();
  } finally {
    await handle.close();
    const currentOwner = await readFile(lockPath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (currentOwner === owner) await rm(lockPath, { force: true });
  }
}

async function ensurePrivateDirectory(directoryPath, platform) {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const details = await lstat(directoryPath);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Workspace credential directory is not a private directory: ${directoryPath}`);
  }
  assertCurrentUserOwns(details, "credential directory");
  if (platform !== "win32") await chmod(directoryPath, 0o700);
}

async function secureExistingFile(filePath, platform) {
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`Workspace credential path is not a regular file: ${filePath}`);
  }
  assertCurrentUserOwns(details, "credential file");
  if (platform !== "win32") await chmod(filePath, 0o600);
}

function assertCurrentUserOwns(details, label) {
  if (typeof process.getuid !== "function") return;
  if (details.uid !== process.getuid()) {
    throw new Error(`Workspace ${label} is not owned by the current user`);
  }
}

function parseCredential(value) {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || typeof parsed.refresh_token !== "string") {
    throw new Error("Saved Workspace credential is invalid");
  }
  return parsed;
}
