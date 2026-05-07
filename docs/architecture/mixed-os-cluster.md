# Mixed-OS AKS Cluster

A single AKS cluster that runs both Linux and Windows container workloads on one shared control plane. This is the Microsoft-recommended approach for mixed-OS deployments and replaces the previous two-cluster design (primary Cilium cluster + separate Windows cluster).

## Why a single cluster?

| | Two-cluster design | Mixed-OS design |
|---|---|---|
| Control plane cost | 2× | 1× |
| Cross-cluster networking | PLS/PE required | Pod-to-pod within VNet |
| Operational complexity | Two kubeconfigs, two Flux installs | One cluster, one context |
| Scaling | Separate autoscalers | Cluster Autoscaler spans all pools |

## Networking: Azure CNI Overlay + Calico

The Cilium dataplane is Linux-only — it cannot coexist with Windows node pools. The mixed-OS cluster uses:

- `networkPlugin: azure`
- `networkPluginMode: overlay` — pod IPs come from an overlay space, not the VNet, preserving IP space
- `networkPolicy: calico` — cross-platform network policy engine that supports both Linux and Windows nodes

## Node pools

| Pool | OS | Mode | Size | Min–Max | Taint | Label |
|---|---|---|---|---|---|---|
| `system` | Linux | System | `Standard_D2s_v4` | 2 fixed | `CriticalAddonsOnly=true:NoSchedule` | — |
| `workers` | Linux | User | `Standard_D4s_v4` | 0–5 | — | `scoped/workload-type=workers` |
| `winusr` | Windows 2022 | User | `Standard_D4s_v4` | 0–5 | `os=windows:NoSchedule` | `scoped/workload-type=workers-windows` |

> **Windows pool name limit:** AKS restricts Windows agent pool names to ≤6 characters. `winusr` satisfies this constraint.

## Pod scheduling convention

Every workload must explicitly declare which OS it targets. This prevents the Cluster Autoscaler from landing Linux pods on Windows nodes (and vice versa) and ensures the Windows taint is respected.

### Linux pods

```yaml
spec:
  nodeSelector:
    kubernetes.io/os: linux
```

No toleration required — the `workers` pool has no taint.

### Windows pods

```yaml
spec:
  nodeSelector:
    kubernetes.io/os: windows
  tolerations:
    - key: os
      value: windows
      effect: NoSchedule
```

The toleration matches the `os=windows:NoSchedule` taint on the `winusr` pool.

---

## Example Deployments

### Linux workload

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: scoped
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      # Pin to Linux nodes — required on a mixed-OS cluster
      nodeSelector:
        kubernetes.io/os: linux
      containers:
        - name: api
          image: acrscopev2dev.azurecr.io/scoped/api:latest
          ports:
            - containerPort: 3000
```

### Windows workload

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: coder-acp-copilot-windows
  namespace: scoped
spec:
  replicas: 1
  selector:
    matchLabels:
      app: coder-acp-copilot-windows
  template:
    metadata:
      labels:
        app: coder-acp-copilot-windows
    spec:
      # Pin to Windows nodes
      nodeSelector:
        kubernetes.io/os: windows
      # Tolerate the os=windows:NoSchedule taint on the winusr pool
      tolerations:
        - key: os
          value: windows
          effect: NoSchedule
      containers:
        - name: coder-acp-copilot-windows
          image: acrscopev2dev.azurecr.io/scoped/coder-acp-copilot-windows:latest
          env:
            - name: NODE_ENV
              value: production
```

---

## Infrastructure (Bicep)

The mixed-OS cluster is defined in `infra/bicep/kubernetes-mixed.bicep` and wired into `main.bicep` via the `deployMixedOsCluster` parameter.

```bash
# Enable when provisioning (azd or az deployment)
DEPLOY_MIXED_OS_CLUSTER=true azd up
```

The cluster reuses the shared ACR from the primary cluster — the kubelet identity of the mixed cluster is granted `AcrPull` automatically.

Workload identity federated credentials for External Secrets Operator are provisioned for both the primary cluster and the mixed cluster when `deployMixedOsCluster=true`.

## References

- [AKS Windows containers overview](https://learn.microsoft.com/en-us/azure/aks/windows-container-cli)
- [Azure CNI Overlay](https://learn.microsoft.com/en-us/azure/aks/azure-cni-overlay)
- [Calico network policy on AKS](https://learn.microsoft.com/en-us/azure/aks/use-network-policies)
- [AKS Windows FAQ](https://learn.microsoft.com/en-us/azure/aks/windows-faq)
