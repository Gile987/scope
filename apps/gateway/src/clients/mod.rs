// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! HTTP clients for external services.
//!
//! Each client is a standalone module with no cross-dependencies — designed to
//! be extractable into its own crate when needed.

pub mod token_manager;
