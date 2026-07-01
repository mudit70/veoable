// One-level-deep config (legacy snake-case naming).
const path = require('path');

module.exports = {
  entry: {
    session: path.resolve('src/session.ts'),
    auth_signin: path.resolve('src/auth_signin.ts'),
  },
  output: {
    path: '../build/assets/sixclear-js',
    filename: '[name].js',
  },
};
