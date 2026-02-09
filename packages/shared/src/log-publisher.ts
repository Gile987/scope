// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const Redis = require("ioredis");
import { Collection } from "mongodb";
import { circuitBreaker, handleAll, ConsecutiveBreaker, CircuitState } from "cockatiel";
import { LogEvent, RequestDocument } from "./types.js";

export interface LogPublisherConfig {
  redisHost: string;
  redisPort: number;
  redisPassword: string;
}

export class LogPublisher {
  private redis: InstanceType<typeof Redis>;
  private collection: Collection<RequestDocument>;
  private redisBreaker = circuitBreaker(handleAll, {
    halfOpenAfter: 60_000, // Try again after 1 minute
    breaker: new ConsecutiveBreaker(3), // Open after 3 consecutive failures
  });

  constructor(config: LogPublisherConfig, collection: Collection<RequestDocument>) {
    // Support both local Redis (no TLS) and Azure Redis (TLS)
    const useTls = config.redisPassword && config.redisPort !== 6379;
    this.redis = new Redis({
      host: config.redisHost,
      port: config.redisPort,
      password: config.redisPassword || undefined,
      ...(useTls ? { tls: { rejectUnauthorized: false } } : {}),
      // Limit reconnection attempts to avoid log spam
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 3) {
          // Stop retrying after 3 attempts
          return null;
        }
        return Math.min(times * 1000, 3000); // Exponential backoff, max 3s
      },
    });
    this.collection = collection;

    // Handle ioredis errors to prevent "Unhandled error event" spam
    this.redis.on("error", (err: Error) => {
      // Only log once when circuit breaker is not already open
      if (this.redisBreaker.state === CircuitState.Closed) {
        console.error("Redis connection error:", err.message);
      }
    });

    // Log circuit breaker state changes
    this.redisBreaker.onStateChange((state) => {
      if (state === CircuitState.Open) {
        console.error("Redis circuit breaker OPEN - stopping Redis publish attempts for 1 minute");
      } else if (state === CircuitState.HalfOpen) {
        console.log("Redis circuit breaker HALF-OPEN - testing connection");
      } else if (state === CircuitState.Closed) {
        console.log("Redis circuit breaker CLOSED - connection restored");
      }
    });
  }

  async publish(
    requestId: string,
    level: LogEvent["level"],
    message: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    const logEvent: LogEvent = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
    };

    // Publish to Redis for real-time streaming (with circuit breaker)
    const channel = `logs:${requestId}`;
    try {
      await this.redisBreaker.execute(() =>
        this.redis.publish(channel, JSON.stringify(logEvent))
      );
    } catch (error) {
      // Silently ignore - circuit breaker handles logging state changes
    }

    // Append to MongoDB for persistence
    try {
      await this.collection.updateOne(
        { _id: requestId },
        {
          $push: { logs: logEvent },
          $set: { updatedAt: new Date() },
        }
      );
    } catch (error) {
      console.error(`Failed to persist log to MongoDB: ${error}`);
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
