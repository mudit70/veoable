module.exports = {
  entry: { main: 'src/main.ts' },
  output: {
    path: 'dist',
    filename: '[name].[contenthash].js',
  },
};
