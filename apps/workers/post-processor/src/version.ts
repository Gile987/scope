// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Post-processor schema version. Bump this whenever:
 * - A new handler is added
 * - An existing handler's output format changes
 * - Reprocessing of existing runs is needed for any reason
 *
 * The scheduler reads this value from the `services` collection in MongoDB
 * (written by the register-version K8s Job on deployment) and dispatches
 * runs whose `postProcessorVersion` is missing or outdated.
 */
export const POST_PROCESSOR_VERSION = 1;
