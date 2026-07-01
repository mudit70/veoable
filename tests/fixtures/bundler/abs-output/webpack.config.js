// `output.path` is an absolute path. Without normalization, the
// resulting SourceFile id wouldn't match lang-html's relative
// `<script src>` resolution.
const path = require('path');

module.exports = {
  entry: {
    main: 'src/main.ts',
  },
  output: {
    path: path.resolve('/abs/build'),
    filename: '[name].js',
  },
};
