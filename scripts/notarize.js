'use strict';

// macOS notarization hook — called by electron-builder after code signing.
//
// Currently a no-op stub: notarization requires an Apple Developer ID
// certificate ($99/yr). When you obtain one, set these env vars in Codemagic:
//   APPLE_ID                  your Apple ID email
//   APPLE_APP_SPECIFIC_PASSWORD  app-specific password from appleid.apple.com
//   APPLE_TEAM_ID             10-character team ID from developer.apple.com
//
// Then update electron-builder.yml mac section:
//   - Remove:  identity: null
//   - Add:     hardenedRuntime: true
//
// No other changes needed — this hook activates automatically when APPLE_ID is set.

exports.default = async function notarizeApp(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID) {
    console.log('[notarize] Skipped — APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set.');
    return;
  }

  const { notarize } = require('@electron/notarize');
  const appName = context.packager.appInfo.productFilename;
  const appPath = `${context.appOutDir}/${appName}.app`;

  console.log(`[notarize] Submitting ${appPath} to Apple notary service…`);
  await notarize({
    tool: 'notarytool',
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
  console.log('[notarize] Done.');
};
