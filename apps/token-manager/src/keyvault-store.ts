// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";

/**
 * Abstraction over secret storage.
 * Implemented by KeyVaultTokenStore (production) and InMemoryTokenStore (local dev).
 */
export interface TokenSecretStore {
  getSecret(name: string): Promise<string>;
  setSecret(name: string, value: string): Promise<void>;
  deleteSecret(name: string): Promise<void>;
}

interface CacheEntry {
  value: string;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Azure KeyVault-backed secret store with in-process caching.
 */
export class KeyVaultTokenStore implements TokenSecretStore {
  private client: SecretClient;
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTtlMs: number;

  constructor(vaultUri: string, cacheTtlMs: number = CACHE_TTL_MS) {
    this.client = new SecretClient(vaultUri, new DefaultAzureCredential());
    this.cacheTtlMs = cacheTtlMs;
  }

  async getSecret(name: string): Promise<string> {
    const cached = this.cache.get(name);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.value;
    }

    const secret = await this.client.getSecret(name);
    if (!secret.value) {
      throw new Error(`Secret '${name}' has no value in KeyVault`);
    }

    this.cache.set(name, { value: secret.value, fetchedAt: Date.now() });
    return secret.value;
  }

  async setSecret(name: string, value: string): Promise<void> {
    await this.client.setSecret(name, value);
    this.cache.set(name, { value, fetchedAt: Date.now() });
  }

  async deleteSecret(name: string): Promise<void> {
    await this.client.beginDeleteSecret(name);
    this.cache.delete(name);
  }
}

/**
 * In-memory secret store for local development (no Azure KeyVault).
 */
export class InMemoryTokenStore implements TokenSecretStore {
  private store: Map<string, string> = new Map();

  async getSecret(name: string): Promise<string> {
    const value = this.store.get(name);
    if (value === undefined) {
      throw new Error(`Secret '${name}' not found in memory store`);
    }
    return value;
  }

  async setSecret(name: string, value: string): Promise<void> {
    this.store.set(name, value);
  }

  async deleteSecret(name: string): Promise<void> {
    this.store.delete(name);
  }
}

/**
 * Factory: returns KeyVaultTokenStore if a vault URI is provided,
 * otherwise InMemoryTokenStore for local development.
 */
export function createTokenStore(keyvaultUri?: string): TokenSecretStore {
  if (keyvaultUri) {
    return new KeyVaultTokenStore(keyvaultUri);
  }
  return new InMemoryTokenStore();
}
