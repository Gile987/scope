// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { QueueClient } from "@azure/storage-queue";
import { DefaultAzureCredential } from "@azure/identity";

/**
 * Creates a getOrCreateQueueClient function that lazily instantiates
 * QueueClients for dynamically resolved queue names, caching them for reuse.
 */
export function createQueueClientFactory(
  storageConnectionString: string,
  storageAccountName: string,
): (queueName: string) => QueueClient {
  const cache = new Map<string, QueueClient>();

  return (queueName: string): QueueClient => {
    const existing = cache.get(queueName);
    if (existing) return existing;

    let client: QueueClient;
    if (storageConnectionString) {
      client = new QueueClient(storageConnectionString, queueName);
    } else {
      const credential = new DefaultAzureCredential();
      const queueUrl = `https://${storageAccountName}.queue.core.windows.net`;
      client = new QueueClient(`${queueUrl}/${queueName}`, credential);
    }
    cache.set(queueName, client);
    return client;
  };
}
