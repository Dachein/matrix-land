/** Missing installation settings must never select another enterprise's service. */
export function missingConfiguration(name: string): never {
  const error = new Error(`Configuration required: ${name}`) as Error & { status: number; code: string };
  error.status = 503;
  error.code = 'installation_configuration_required';
  throw error;
}

export function configuredServiceUrl(value: string | undefined, name: string): string {
  if (!value?.trim()) return missingConfiguration(name);
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    throw new Error(`Invalid service URL: ${name}`);
  }
  return url.toString().replace(/\/+$/, '');
}
