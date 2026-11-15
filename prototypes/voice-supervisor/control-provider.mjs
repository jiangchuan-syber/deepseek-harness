import { MiioLampProvider } from './miio-provider.mjs';

/** Compose an explicitly configured provider without starting a process or reading a device. */
export function createControlProvider(config) {
  if (config?.kind === 'miio-lamp') {
    if (config.enabled !== true) throw new Error('simpleControl provider must be explicitly enabled');
    return new MiioLampProvider(config);
  }
  if (config?.kind === 'composed' && ['resolve', 'write', 'readFresh'].every(key => typeof config.instance?.[key] === 'function')) {
    return config.instance;
  }
  throw new Error('simpleControl.provider requires miio-lamp or an explicit composed provider');
}
