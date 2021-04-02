// Ensure that, regardless of where in the world the tests are running, Node is using the same timezone (GMT).
process.env.TZ = 'GMT';

module.exports = {
  injectGlobals: false,
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  testRegex: '/test/.*|(\\.|/(test|spec))\\.tsx?$',
  moduleFileExtensions: ['ts', 'js'],
  // Indicates whether the coverage information should be collected while executing the test
  collectCoverage: false,
  // The directory where Jest should output its coverage files
  coverageDirectory: 'jest-coverage',
};
