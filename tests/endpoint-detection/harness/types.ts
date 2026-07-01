/**
 * Shared types for endpoint detection test fixtures (#32).
 *
 * Every framework fixture has an `expected.json` conforming to this schema.
 * The test runner loads the fixture, runs the detection pipeline, and
 * compares the output against the expected endpoints.
 */

/**
 * Expected endpoint in a test fixture.
 * Matches a subset of APIEndpoint fields for assertion.
 */
export interface ExpectedEndpoint {
  /** HTTP method: GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS, ALL */
  httpMethod: string;
  /** Route pattern with :param normalization */
  routePattern: string;
  /** Framework that should detect this endpoint */
  framework: string;
}

/**
 * Expected detection result for a fixture.
 */
export interface ExpectedDetectionResult {
  /** Description of what this fixture tests */
  description: string;
  /** The framework plugin ID that should be active */
  pluginId: string;
  /** Language of the fixture files */
  language: string;
  /** Expected endpoints to be detected */
  endpoints: ExpectedEndpoint[];
  /** Endpoints that should NOT be detected (negative cases) */
  negativePatterns?: string[];
}
