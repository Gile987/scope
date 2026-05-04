#!/usr/bin/env bash
# bootstrap-win-cluster.sh
#
# Idempotent bootstrap for the Windows AKS cluster.
# Safe to re-run — uses --dry-run=client + apply everywhere.
#
# What it does:
#   1. Gets credentials for the Windows cluster
#   2. Creates the 'scoped' namespace
#   3. Installs KEDA via Helm (same version as Linux cluster)
#   4. Installs ESO via Helm
#   5. Creates the ESO ServiceAccount (with Workload Identity annotation)
#   6. Creates the ESO ClusterSecretStore pointing at the shared Key Vault
#   7. Applies ExternalSecret for worker-secrets (same as Linux cluster)
#   8. Creates a cross-cluster worker-config (external URLs for API + token-manager)
#   9. Applies the KEDA TriggerAuthentication
#  10. Applies the Windows worker Deployment + ScaledObject
#
# Prerequisites:
#   - az CLI logged in
#   - helm installed
#   - jq installed
#   - Both clusters provisioned
#   - azd provision run after adding Win cluster ESO federated credential
#   - Dev overlay applied to Linux cluster (token-manager-internal ILB + PLS)
#     The PLS is created automatically by the azure-pls-create annotation on the Service.
#     See deploy/overlays/dev/token-manager-lb.yaml

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────
RESOURCE_GROUP="rg-scope-v2-dev"
LINUX_CLUSTER="aks-scope-v2-dev"
WIN_CLUSTER="aks-scope-v2-dev-win"
NAMESPACE="scoped"
KEDA_VERSION="2.16.1"
ESO_VERSION="0.15.1"
ACR_LOGIN_SERVER="acrscopev2dev.azurecr.io"
AZURE_STORAGE_ACCOUNT_NAME="stscopev2dev"
AZURE_TENANT_ID="d91aa5af-8c1e-442c-b77c-0b92988b387b"

# Path to the Windows worker manifest (Deployment + ScaledObject).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKER_MANIFEST="${WORKER_MANIFEST:-$REPO_ROOT/deploy/base/workers/coder-acp-copilot-windows.yaml}"
KEDA_AUTH_MANIFEST="$REPO_ROOT/deploy/base/workers/keda-auth.yaml"
ESO_EXTERNAL_SECRET="$REPO_ROOT/deploy/base/workers/worker-secrets.yaml"

# ── Helpers ────────────────────────────────────────────────────────────────────
log() { echo "▶ $*"; }
linux_kubectl() { kubectl --context "$LINUX_CLUSTER" "$@"; }
win_kubectl()   { kubectl --context "$WIN_CLUSTER"   "$@"; }

# ── Step 1: Credentials ────────────────────────────────────────────────────────
log "Fetching credentials for $WIN_CLUSTER..."
az aks get-credentials \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WIN_CLUSTER" \
  --overwrite-existing
kubelogin convert-kubeconfig -l azurecli

# ── Step 2: Namespace ──────────────────────────────────────────────────────────
log "Creating namespace '$NAMESPACE'..."
win_kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | win_kubectl apply -f -

# ── Step 3: KEDA ───────────────────────────────────────────────────────────────
log "Installing KEDA $KEDA_VERSION via Helm..."
helm repo add kedacore https://kedacore.github.io/charts --force-update
helm repo update kedacore
helm upgrade --install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version "$KEDA_VERSION" \
  --kube-context "$WIN_CLUSTER" \
  --set tolerations[0].key=CriticalAddonsOnly \
  --set tolerations[0].operator=Equal \
  --set-string tolerations[0].value=true \
  --set tolerations[0].effect=NoSchedule \
  --set 'nodeSelector.kubernetes\.azure\.com/mode=system' \
  --set metricsServer.tolerations[0].key=CriticalAddonsOnly \
  --set metricsServer.tolerations[0].operator=Equal \
  --set-string metricsServer.tolerations[0].value=true \
  --set metricsServer.tolerations[0].effect=NoSchedule \
  --set 'metricsServer.nodeSelector.kubernetes\.azure\.com/mode=system' \
  --set webhooks.tolerations[0].key=CriticalAddonsOnly \
  --set webhooks.tolerations[0].operator=Equal \
  --set-string webhooks.tolerations[0].value=true \
  --set webhooks.tolerations[0].effect=NoSchedule \
  --set 'webhooks.nodeSelector.kubernetes\.azure\.com/mode=system' \
  --wait

# ── Step 4: ESO ────────────────────────────────────────────────────────────────
log "Installing External Secrets Operator $ESO_VERSION via Helm..."
helm repo add external-secrets https://charts.external-secrets.io --force-update
helm repo update external-secrets
helm upgrade --install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --version "$ESO_VERSION" \
  --kube-context "$WIN_CLUSTER" \
  --set installCRDs=true \
  --set 'tolerations[0].key=CriticalAddonsOnly' \
  --set 'tolerations[0].operator=Equal' \
  --set-string 'tolerations[0].value=true' \
  --set 'tolerations[0].effect=NoSchedule' \
  --set 'nodeSelector.kubernetes\.azure\.com/mode=system' \
  --set 'webhook.tolerations[0].key=CriticalAddonsOnly' \
  --set 'webhook.tolerations[0].operator=Equal' \
  --set-string 'webhook.tolerations[0].value=true' \
  --set 'webhook.tolerations[0].effect=NoSchedule' \
  --set 'webhook.nodeSelector.kubernetes\.azure\.com/mode=system' \
  --set 'certController.tolerations[0].key=CriticalAddonsOnly' \
  --set 'certController.tolerations[0].operator=Equal' \
  --set-string 'certController.tolerations[0].value=true' \
  --set 'certController.tolerations[0].effect=NoSchedule' \
  --set 'certController.nodeSelector.kubernetes\.azure\.com/mode=system' \
  --wait --timeout 5m

# ── Step 5: ESO ServiceAccount (Workload Identity) ────────────────────────────
log "Resolving ESO identity from Linux cluster infra-outputs..."
AZURE_IDENTITY_CLIENT_ID=$(linux_kubectl get configmap infra-outputs -n flux-system \
  -o jsonpath='{.data.AZURE_IDENTITY_CLIENT_ID}')
AZURE_KEYVAULT_URI=$(linux_kubectl get configmap infra-outputs -n flux-system \
  -o jsonpath='{.data.AZURE_KEYVAULT_URI}')

log "  AZURE_IDENTITY_CLIENT_ID = $AZURE_IDENTITY_CLIENT_ID"
log "  AZURE_KEYVAULT_URI        = $AZURE_KEYVAULT_URI"

log "Applying ESO ServiceAccount..."
win_kubectl apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: eso-secret-store-sa
  namespace: $NAMESPACE
  annotations:
    azure.workload.identity/client-id: "$AZURE_IDENTITY_CLIENT_ID"
  labels:
    azure.workload.identity/use: "true"
EOF

# ── Step 6: ESO ClusterSecretStore ────────────────────────────────────────────
log "Applying ESO ClusterSecretStore..."
win_kubectl apply -f - <<EOF
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: azure-keyvault
spec:
  provider:
    azurekv:
      vaultUrl: "$AZURE_KEYVAULT_URI"
      tenantId: "$AZURE_TENANT_ID"
      authType: WorkloadIdentity
      serviceAccountRef:
        name: eso-secret-store-sa
        namespace: $NAMESPACE
EOF

# ── Step 7: ExternalSecret for worker-secrets ─────────────────────────────────
log "Applying ExternalSecret for worker-secrets..."
win_kubectl apply -f "$ESO_EXTERNAL_SECRET"

log "Waiting for worker-secrets to sync (up to 60s)..."
timeout 60 bash -c "
  until win_kubectl get secret worker-secrets -n $NAMESPACE &>/dev/null; do
    sleep 5
    echo '  waiting...'
  done
" || { echo "ERROR: worker-secrets did not sync. Check ESO logs."; exit 1; }

# ── Step 8: Cross-cluster worker-config ───────────────────────────────────────
log "Resolving service endpoints from $LINUX_CLUSTER..."

API_IP=$(linux_kubectl get svc api -n "$NAMESPACE" \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

# token-manager is exposed via Azure Private Link Service on the Linux cluster.
# We create a Private Endpoint in the Windows cluster's subnet pointing at that PLS,
# then use the PE's private IP as TOKEN_MANAGER_URL.
#
# This is required because the Linux cluster uses Cilium eBPF (no kube-proxy).
# NodePort and plain ILB both fail for cross-cluster traffic from another AKS cluster
# in the same VNet. PLS/PE is CNI-agnostic — the Azure fabric handles L4 forwarding
# before the packet reaches any Linux node.
# See: https://github.com/growth-ecosystems/scope-core-infra/issues/59

log "Resolving Private Link Service for token-manager..."
LINUX_NODE_RG=$(az aks show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$LINUX_CLUSTER" \
  --query nodeResourceGroup -o tsv)

PLS_ID=$(az network private-link-service list \
  --resource-group "$LINUX_NODE_RG" \
  --query "[?name=='pls-token-manager-dev'].id | [0]" -o tsv)

if [[ -z "$PLS_ID" ]]; then
  echo "ERROR: Private Link Service 'pls-token-manager-dev' not found in $LINUX_NODE_RG."
  echo "  Ensure the dev overlay (token-manager-lb.yaml) has been applied to $LINUX_CLUSTER"
  echo "  and wait ~2 minutes for the cloud-controller to create the PLS."
  exit 1
fi

log "  PLS ID = $PLS_ID"

# Get the Windows cluster's subnet ID for the Private Endpoint.
WIN_SUBNET_ID=$(az aks show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WIN_CLUSTER" \
  --query "agentPoolProfiles[?mode=='System'].vnetSubnetId | [0]" -o tsv)

log "Creating Private Endpoint 'pe-token-manager-dev' in Windows cluster subnet..."
az network private-endpoint create \
  --resource-group "$RESOURCE_GROUP" \
  --name "pe-token-manager-dev" \
  --vnet-name vnet-scope-v2-dev \
  --subnet "$(basename "$WIN_SUBNET_ID")" \
  --private-connection-resource-id "$PLS_ID" \
  --connection-name "conn-token-manager-dev" \
  --manual-request false \
  --output none 2>/dev/null || log "  (Private Endpoint already exists, skipping)"

TOKEN_MANAGER_PE_IP=$(az network private-endpoint show \
  --resource-group "$RESOURCE_GROUP" \
  --name "pe-token-manager-dev" \
  --query "customDnsConfigs[0].ipAddresses[0]" -o tsv 2>/dev/null)

# Fall back to NIC IP if customDnsConfigs not yet populated
if [[ -z "$TOKEN_MANAGER_PE_IP" ]]; then
  PE_NIC_ID=$(az network private-endpoint show \
    --resource-group "$RESOURCE_GROUP" \
    --name "pe-token-manager-dev" \
    --query "networkInterfaces[0].id" -o tsv)
  TOKEN_MANAGER_PE_IP=$(az network nic show --ids "$PE_NIC_ID" \
    --query "ipConfigurations[0].privateIPAddress" -o tsv)
fi

if [[ -z "$TOKEN_MANAGER_PE_IP" ]]; then
  echo "ERROR: could not resolve Private Endpoint IP for pe-token-manager-dev."
  exit 1
fi

TOKEN_MANAGER_URL="http://$TOKEN_MANAGER_PE_IP"

log "  SCOPE_MT_API_URL  = http://$API_IP"
log "  TOKEN_MANAGER_URL = $TOKEN_MANAGER_URL (via Private Endpoint)"

win_kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: worker-config
  namespace: $NAMESPACE
data:
  AZURE_STORAGE_ACCOUNT_NAME: "$AZURE_STORAGE_ACCOUNT_NAME"
  MONGO_DATABASE: "scope-mt"
  MONGO_COLLECTION: "requests"
  SCOPE_MT_API_URL: "http://$API_IP"
  TOKEN_MANAGER_URL: $TOKEN_MANAGER_URL
  JUDGE_SERVICE_URL: "http://$API_IP"
EOF

# ── Step 9: KEDA TriggerAuthentication ────────────────────────────────────────
log "Applying KEDA TriggerAuthentication..."
win_kubectl apply -f "$KEDA_AUTH_MANIFEST"

# ── Step 10: Windows worker manifest ──────────────────────────────────────────
if [[ ! -f "$WORKER_MANIFEST" ]]; then
  echo "ERROR: Worker manifest not found at: $WORKER_MANIFEST"
  echo "  Set WORKER_MANIFEST env var to the path of coder-acp-copilot-windows.yaml"
  exit 1
fi

log "Applying Windows worker manifest from $WORKER_MANIFEST..."
ACR_LOGIN_SERVER="$ACR_LOGIN_SERVER" \
AZURE_STORAGE_ACCOUNT_NAME="$AZURE_STORAGE_ACCOUNT_NAME" \
  envsubst < "$WORKER_MANIFEST" | win_kubectl apply -f -

# ── Done ───────────────────────────────────────────────────────────────────────
log ""
log "Bootstrap complete. Verify:"
log "  kubectl --context $WIN_CLUSTER get pods -n $NAMESPACE"
log "  kubectl --context $WIN_CLUSTER get externalsecret -n $NAMESPACE"
log "  kubectl --context $WIN_CLUSTER get scaledobject -n $NAMESPACE"
