const nodeExternals = require('webpack-node-externals');
const { RunScriptWebpackPlugin } = require('run-script-webpack-plugin');

// `nest build --watch` (start:dev) needs webpack to run the app itself (hot
// reload). `nest start` already runs it, so doing it here too started two
// copies: double memory, "address in use", jobs and queues handled twice.
const selfRun =
  process.argv.includes('build') && process.argv.includes('--watch');

module.exports = function (options, webpack) {
  return {
    ...options,
    entry: selfRun ? ['webpack/hot/poll?100', options.entry] : options.entry,
    resolve: {
      ...options.resolve,
      extensionAlias: {
        '.js': ['.js', '.ts'],
      },
    },
    externals: [
      nodeExternals({
        allowlist: ['webpack/hot/poll?100'],
      }),
    ],
    plugins: [
      // No type-checking during the dev build: on this codebase (Prisma client
      // with 130+ models) it needs more memory than Node's default heap and
      // crashed `nest start`. Types are checked by the editor, lint and
      // `pnpm typecheck`.
      ...options.plugins.filter(
        (p) => p.constructor.name !== 'ForkTsCheckerWebpackPlugin',
      ),
      ...(selfRun
        ? [
            new webpack.HotModuleReplacementPlugin(),
            new webpack.WatchIgnorePlugin({
              paths: [/\.js$/, /\.d\.ts$/],
            }),
            new RunScriptWebpackPlugin({
              name: options.output.filename,
              autoRestart: false,
            }),
          ]
        : []),
    ],
  };
};
