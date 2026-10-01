const { withMainApplication } = require('expo/config-plugins');

// Expo 58's template omits useDevSupport; the factory then reads the DEBUG
// constant of the prebuilt React Native library instead of the application.
function patchMainApplication(contents) {
  const invocation = /(ExpoReactHostFactory\.getDefaultReactHost\(\s*\n)(\s*)context = applicationContext,/;
  if (!invocation.test(contents)) {
    throw new Error('Expected the Expo 58 Kotlin getDefaultReactHost application template.');
  }
  if (/ExpoReactHostFactory\.getDefaultReactHost\(\s*\n\s*context = applicationContext,\s*\n\s*useDevSupport = BuildConfig\.DEBUG,/.test(contents)) {
    return contents;
  }
  return contents.replace(invocation, '$1$2context = applicationContext,\n$2useDevSupport = BuildConfig.DEBUG,');
}

module.exports = function withAndroidDevSupport(config) {
  return withMainApplication(config, (config) => {
    if (config.modResults.language !== 'kt') {
      throw new Error('The LiveView Native example expects the Expo 58 Kotlin application template.');
    }
    config.modResults.contents = patchMainApplication(config.modResults.contents);
    return config;
  });
};

module.exports.patchMainApplication = patchMainApplication;
