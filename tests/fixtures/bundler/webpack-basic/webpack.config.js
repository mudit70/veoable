const path = require('path');

const buildDir = path.resolve('build', 'assets');

module.exports = {
  entry: {
    main: path.resolve('src/main.ts'),
    auth_signin: path.resolve('src/auth_signin.ts'),
    my_account: 'src/my_account.ts',
  },
  output: {
    path: buildDir,
    filename: '[name].js',
  },
};
