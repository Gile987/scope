// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Output format types for CLI list commands.
 * Ported from ca-geo/packages/cli reference implementation.
 */

/** Supported output formats for list commands */
export type OutputFormat = 'table' | 'tsv' | 'json';

/** All valid output format values */
export const OUTPUT_FORMAT_VALUES: OutputFormat[] = ['table', 'tsv', 'json'];

/** Display field descriptor — unified across all output formats */
export interface DisplayField<T = any> {
  /** Property key on the data object (supports nested access via formatter) */
  key: string;
  /** Column header label (used in table headers and list labels) */
  label: string;
  /** Optional fixed column width for table format */
  width?: number;
  /** Optional custom formatter — receives the full item, returns display string */
  formatter?: (item: T) => string;
}

/** Table column descriptor (used internally by formatAsTable) */
export interface TableColumn<T = any> {
  key: string;
  header: string;
  width?: number;
  formatter?: (item: T) => string;
}

/** Generic list item with flexible properties */
export interface ListItem {
  id?: string;
  [key: string]: any;
}
