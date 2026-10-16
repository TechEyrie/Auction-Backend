/**
 * Minimum length for the operator bootstrap token.
 *
 * Shared by configuration validation and the bootstrap command so both agree on
 * what counts as an explicit, non-guessable token. Lives outside `modules/admin`
 * because configuration must not depend on a feature module.
 */
export const MIN_BOOTSTRAP_TOKEN_LENGTH = 16;
