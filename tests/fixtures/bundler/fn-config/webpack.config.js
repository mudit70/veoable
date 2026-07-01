module.exports = (env) => ({
  entry: env.production ? 'src/prod.ts' : 'src/dev.ts',
  output: { path: 'dist', filename: '[name].js' },
});
