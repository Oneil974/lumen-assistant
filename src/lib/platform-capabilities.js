// Platform support, independent of runtime readiness (installed engine, GPU,
// permissions and model remain separate checks). Unknown never implies macOS.
export function platformCapabilities({ flavor = '', platform = '', userAgent = '' } = {}) {
  const browserMac = /Mac/i.test(platform || userAgent);
  const os = flavor === 'windows' ? 'windows'
    : ['rpi', 'linux-standard'].includes(flavor) ? 'linux'
    : flavor === 'default' && browserMac ? 'macos'
    : /Windows/i.test(platform || userAgent) ? 'windows'
    : browserMac ? 'macos'
    : /Linux/i.test(platform || userAgent) ? 'linux' : 'unknown';
  return Object.freeze({
    os,
    appleIntegration: os === 'macos' && !['windows', 'rpi', 'linux-standard'].includes(flavor),
    gpio: flavor === 'rpi',
    httpAppScheme: os === 'windows' || /Android/i.test(userAgent),
  });
}
export function appOrigin(id, userAgent = globalThis.navigator?.userAgent || '') {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(id || ''))) throw new Error('Invalid application id');
  return platformCapabilities({ userAgent }).httpAppScheme ? `http://lumenapp.localhost/${id}` : `lumenapp://${id}`;
}
