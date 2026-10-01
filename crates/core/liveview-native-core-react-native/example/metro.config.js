const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const moduleRoot = path.resolve(__dirname, '..');
config.watchFolders = [moduleRoot];
// The local package is a symlink. Resolve React and RN from the app so its hooks
// and renderer share one runtime even when the package has devDependencies.
config.resolver.disableHierarchicalLookup = true;
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(moduleRoot, 'node_modules'),
];

module.exports = config;
