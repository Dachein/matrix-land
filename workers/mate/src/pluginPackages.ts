import { unzipSync } from 'fflate';
import { RuntimeHttpError } from './types.ts';

/** Instructions and text resources only. Packages never run installation scripts. */
export function readSkillPackage(bytes: Uint8Array) {
  if (bytes.length > 400_000) throw new RuntimeHttpError(413, 'mate_skill_package_too_large');
  let total = 0, count = 0;
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes, { filter(file) {
      if (file.name.endsWith('/')) return false;
      total += file.originalSize;
      if (++count > 64 || total > 350_000) throw new RuntimeHttpError(413, 'mate_skill_package_too_large');
      if (file.name.startsWith('/') || file.name.includes('\\') || file.name.split('/').some(part => part === '..' || part === '.'))
        throw new RuntimeHttpError(400, 'mate_skill_package_path_invalid');
      return true;
    } });
  } catch (error) {
    if (error instanceof RuntimeHttpError) throw error;
    throw new RuntimeHttpError(400, 'mate_skill_package_invalid');
  }
  const entrypoints = Object.keys(archive).filter(path => path === 'SKILL.md' || path.endsWith('/SKILL.md'));
  if (entrypoints.length !== 1) throw new RuntimeHttpError(400, 'mate_skill_package_entrypoint_invalid');
  const root = entrypoints[0]!.slice(0, -'SKILL.md'.length);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const files = Object.entries(archive).map(([name, data]) => {
    if (!name.startsWith(root)) throw new RuntimeHttpError(400, 'mate_skill_package_path_invalid');
    let content: string;
    try { content = decoder.decode(data); } catch { throw new RuntimeHttpError(400, 'mate_skill_package_text_only'); }
    if (content.includes('\0')) throw new RuntimeHttpError(400, 'mate_skill_package_text_only');
    return { path: name.slice(root.length), content };
  });
  const skillMarkdown = files.find(file => file.path === 'SKILL.md')!.content;
  if (skillMarkdown.length > 200_000) throw new RuntimeHttpError(413, 'mate_skill_package_too_large');
  let version = '1.0.0';
  const metadata = files.find(file => file.path === 'pintail.json');
  if (metadata) {
    try { const value = JSON.parse(metadata.content); if (typeof value.version === 'string' && value.version.length <= 64) version = value.version; }
    catch { throw new RuntimeHttpError(400, 'mate_skill_package_manifest_invalid'); }
  }
  return { skillMarkdown, version, files: files.filter(file => file.path !== 'SKILL.md' && file.path !== 'pintail.json'),
    scriptsExecuted: false, transport: 'cloud-instructions' };
}
