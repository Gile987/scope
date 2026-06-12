// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * When the API returns a masked secret value it uses the sentinel `"<secret>"`.
 * The UI should display an empty input (so the user types a new value to
 * replace the secret) rather than the literal sentinel string.
 *
 * Returns "" when the value is the masked sentinel, otherwise the original value.
 */
export function unmaskSecretValue(value: string): string {
  return value === "<secret>" ? "" : value;
}
