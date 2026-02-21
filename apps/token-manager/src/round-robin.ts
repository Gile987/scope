// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Round-robin selector — cycles through items using a modulo counter.
 */
export class RoundRobinSelector<T> {
  private counter: number = 0;

  /**
   * Return the next item from the array, cycling through in order.
   * @throws Error if the array is empty.
   */
  next(items: T[]): T {
    if (items.length === 0) {
      throw new Error("Cannot select from empty array");
    }
    const index = this.counter % items.length;
    this.counter++;
    return items[index];
  }
}

/**
 * Map of round-robin selectors, one per key (e.g., per TokenUsage).
 * Each key has its own independent counter.
 */
export class RoundRobinMap<T> {
  private selectors: Map<string, RoundRobinSelector<T>> = new Map();

  /**
   * Return the next item for the given key's round-robin rotation.
   */
  next(key: string, items: T[]): T {
    let selector = this.selectors.get(key);
    if (!selector) {
      selector = new RoundRobinSelector<T>();
      this.selectors.set(key, selector);
    }
    return selector.next(items);
  }
}
