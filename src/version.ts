import packageJson from '../package.json';

declare const __KVM_RECON_BUILD_ID__: string | undefined;

export const APP_VERSION = packageJson.version;
export const BUILD_ID =
  typeof __KVM_RECON_BUILD_ID__ === 'string' && __KVM_RECON_BUILD_ID__
    ? __KVM_RECON_BUILD_ID__
    : 'development';
