export default {
  entry: {
    bundle_a: 'src/a.ts',
    bundle_b: 'src/b.ts',
  },
  output: {
    path: 'dist',
    filename: '[name].js',
  },
};
