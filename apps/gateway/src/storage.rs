// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use anyhow::anyhow;
use azure_storage::{ConnectionString, StorageCredentials};

/// Parses an Azure Storage connection string and returns the account name
/// together with the matching [`StorageCredentials`].
///
/// The account name (not the full URL) is returned because
/// [`BlobServiceClient::new`] expects just the account name and constructs
/// the endpoint URL internally.
pub fn parse_connection_string(conn_str: &str) -> anyhow::Result<(String, StorageCredentials)> {
    let parsed = ConnectionString::new(conn_str)
        .map_err(|e| anyhow!("Invalid STORAGE_CONNECTION_STRING: {}", e))?;
    let account_name = parsed
        .account_name
        .ok_or_else(|| anyhow!("AccountName missing from STORAGE_CONNECTION_STRING"))?
        .to_string();
    let storage_creds = parsed
        .storage_credentials()
        .map_err(|e| anyhow!("Failed to build storage credentials: {}", e))?;
    Ok((account_name, storage_creds))
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_CONN_STR: &str =
        "DefaultEndpointsProtocol=https;AccountName=myaccount;AccountKey=dGVzdGtleQ==;EndpointSuffix=core.windows.net";

    #[test]
    fn parses_valid_connection_string() {
        let (account, _creds) = parse_connection_string(VALID_CONN_STR).unwrap();
        assert_eq!(account, "myaccount");
    }

    #[test]
    fn errors_on_missing_account_name() {
        let conn_str = "DefaultEndpointsProtocol=https;AccountKey=dGVzdGtleQ==;EndpointSuffix=core.windows.net";
        let err = parse_connection_string(conn_str).unwrap_err();
        assert!(
            err.to_string().contains("AccountName"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn errors_on_invalid_connection_string() {
        let err = parse_connection_string("not-a-connection-string").unwrap_err();
        assert!(
            err.to_string()
                .contains("Invalid STORAGE_CONNECTION_STRING"),
            "unexpected error: {err}"
        );
    }
}
