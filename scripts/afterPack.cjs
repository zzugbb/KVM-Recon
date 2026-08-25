const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

/**
 * macOS 未使用 Apple 开发者证书时，完全不签名会被 Gatekeeper 报成「已损坏」。
 * ad-hoc 签名后，提示变为「无法验证开发者」，可在「隐私与安全性」中允许打开。
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync(
    'codesign',
    ['--sign', '-', '--force', '--deep', '--timestamp=none', appPath],
    { stdio: 'inherit' },
  );
};
