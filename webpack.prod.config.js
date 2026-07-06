// Production webpack config for `nest build` — unlike webpack-hmr.config.js
// (the dev default from nest-cli.json), this has no hot-reload entry and no
// RunScriptWebpackPlugin, so the build compiles once and exits.
const nodeExternals = require('webpack-node-externals');

module.exports = function (options) {
  return {
    ...options,
    resolve: {
      ...options.resolve,
      extensionAlias: {
        '.js': ['.js', '.ts'],
      },
    },
    externals: [nodeExternals()],
  };
};
