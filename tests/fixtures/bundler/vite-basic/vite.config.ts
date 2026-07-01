import { defineConfig } from 'vite';

export default defineConfig({
  entry: 'src/main.ts',
  output: {
    path: 'dist',
    filename: '[name].js',
  },
});
