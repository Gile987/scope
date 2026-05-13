# =============================================================================
# Tiltfile — Scoped local K8s development
# =============================================================================
# Provides AKS-parity local development with hot reload via Tilt + k3d.
# Reads port offsets from worktree-env generated .env for multi-worktree
# isolation. Uses the same Kustomize manifests as production.
#
# Prerequisites:
#   brew install tilt k3d kustomize
#   ./scripts/k3d-setup.sh          # creates cluster
#
# Usage:
#   worktree-env && tilt up          # all services (workers run at replicas=1)
#   worktree-env && tilt down        # tear down
# =============================================================================

# ---------------------------------------------------------------------------
# Parse worktree-env generated .env for port offsets
# ---------------------------------------------------------------------------
def read_dotenv(path='.env'):
    """Parse .env into a dict, skipping comments and managed-block markers."""
    env = {}
    content = str(read_file(path, ''))
    if not content:
        return env
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' in line:
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()
    return env

env = read_dotenv()

# Port offsets from worktree-env (defaults match .env.base)
API_PORT       = int(env.get('API_PORT', '3100'))
PORTAL_PORT    = int(env.get('PORTAL_PORT', '5100'))
JUDGE_PORT     = int(env.get('JUDGE_PORT', '3200'))
TM_PORT        = int(env.get('TOKEN_MANAGER_PORT', '3300'))
MONGODB_PORT   = int(env.get('MONGODB_PORT', '27000'))
REDIS_PORT     = int(env.get('REDIS_PORT', '6300'))
GATEWAY_PORT   = int(env.get('GATEWAY_API_PORT', '18900'))
PROJECT_NAME   = env.get('COMPOSE_PROJECT_NAME', 'scope-mt-app')

# Workers that require version build-args — only build when the env vars are set.
# Set these in .env or export them before running `tilt up`.
_claude_code_version = env.get('CLAUDE_CODE_ACP_VERSION', '')
_vscode_version = env.get('VSCODE_VERSION', '')
_copilot_chat_version = env.get('COPILOT_CHAT_VERSION', '')

# ---------------------------------------------------------------------------
# Apply Kustomize manifests
# All workers are deployed with replicas=1 in local dev (no KEDA auto-scaling).
# --load-restrictor=LoadRestrictionsNone allows cherry-picking individual
# files from deploy/base/ without pulling in Azure-only resources (ASO,
# ExternalSecrets, ClusterSecretStore).
# ---------------------------------------------------------------------------
# Base manifests use ${ACR_LOGIN_SERVER}/scoped/<name> as image placeholders
# (FluxCD image automation). Kustomize's images transformer can't parse these
# as valid references, so we sed-replace them to short names that match
# docker_build() refs.
#
# The filter script removes KEDA ScaledObjects/TriggerAuthentication (not used
# locally — workers always run at replicas=1) and any disabled worker manifests
# whose version build-args are not set.
_exclude_kinds = ['ScaledObject', 'TriggerAuthentication']
_exclude_names = []
if not _claude_code_version:
    _exclude_names.append('coder-acp-claude-code')
if not _vscode_version:

_filter_args = ' '.join(
    ['--exclude-kind %s' % k for k in _exclude_kinds] +
    ['--exclude-name %s' % n for n in _exclude_names],
)

k8s_yaml(local(
    "kustomize build --load-restrictor=LoadRestrictionsNone deploy/overlays/local" +
    " | sed 's|${ACR_LOGIN_SERVER}/scoped/|scoped/|g'" +
    " | python3 scripts/filter-k8s-yaml.py " + _filter_args,
    quiet=True,
))

# Re-run kustomize when overlay or base manifests change
watch_file('deploy/overlays/local')
watch_file('deploy/base')

# ---------------------------------------------------------------------------
# Image builds with live_update (hot reload)
# ---------------------------------------------------------------------------
# The host Docker is Podman (no BuildKit gRPC). Use custom_build() to invoke
# the legacy builder and import images into the k3d cluster.
# ---------------------------------------------------------------------------

K3D_CLUSTER = 'scoped'

def scope_build(ref, context, dockerfile, target='', deps=[], live_update_syncs=[], build_args={}):
    """Build an image with docker (legacy) and import into k3d."""
    target_arg = '--target %s' % target if target else ''
    args_str = ' '.join(['--build-arg %s=%s' % (k, v) for k, v in build_args.items()])
    # Podman stores images with docker.io/ prefix; k3d needs that to find them.
    # k3d image import can fail intermittently when concurrent builds race for
    # the tools container, so retry up to 3 times with a short backoff.
    cmd = (
        'docker build -t $EXPECTED_REF -f %s %s %s %s' % (dockerfile, target_arg, args_str, context) +
        ' && for _attempt in 1 2 3; do' +
        ' k3d image import docker.io/$EXPECTED_REF -c %s && break' % K3D_CLUSTER +
        ' || { echo "k3d import attempt $_attempt failed, retrying..."; sleep 3; };' +
        ' done'
    )
    custom_build(
        ref,
        cmd,
        deps=deps,
        live_update=live_update_syncs,
        skips_local_docker=True,
    )

# --- API ---
scope_build(
    'scoped/api', '.', 'apps/api/Dockerfile', target='dev',
    deps=['apps/api/src', 'apps/api/package.json', 'packages/shared/src', 'config'],
    live_update_syncs=[
        sync('apps/api/src', '/app/apps/api/src'),
        sync('packages/shared/src', '/app/packages/shared/src'),
        sync('config', '/app/config'),
    ],
)

# --- Judge ---
scope_build(
    'scoped/judge', '.', 'apps/judge/Dockerfile', target='dev',
    deps=['apps/judge/src', 'apps/judge/package.json', 'packages/shared/src', 'config'],
    live_update_syncs=[
        sync('apps/judge/src', '/app/apps/judge/src'),
        sync('packages/shared/src', '/app/packages/shared/src'),
        sync('config', '/app/config'),
    ],
)

# --- Token Manager ---
scope_build(
    'scoped/token-manager', '.', 'apps/token-manager/Dockerfile', target='dev',
    deps=['apps/token-manager/src', 'apps/token-manager/package.json', 'packages/shared/src'],
    live_update_syncs=[
        sync('apps/token-manager/src', '/app/apps/token-manager/src'),
        sync('packages/shared/src', '/app/packages/shared/src'),
    ],
)

# --- Scheduler ---
scope_build(
    'scoped/scheduler', '.', 'apps/scheduler/Dockerfile', target='dev',
    deps=['apps/scheduler/src', 'apps/scheduler/package.json', 'packages/shared/src'],
    live_update_syncs=[
        sync('apps/scheduler/src', '/app/apps/scheduler/src'),
        sync('packages/shared/src', '/app/packages/shared/src'),
    ],
)

# --- Portal ---
scope_build(
    'scoped/portal', '.', 'apps/portal/Dockerfile', target='dev',
    deps=['apps/portal/src', 'apps/portal/package.json'],
    live_update_syncs=[
        sync('apps/portal/src', '/app/apps/portal/src'),
    ],
)

# --- Gateway ---
scope_build(
    'scoped/gateway', 'apps/gateway', 'apps/gateway/Dockerfile',
    deps=['apps/gateway/src', 'apps/gateway/Cargo.toml', 'apps/gateway/config'],
)

# --- DB Migrations ---
scope_build(
    'scoped/db-migrations', '.', 'packages/db-migrations/Dockerfile',
    deps=['packages/db-migrations/src', 'packages/db-migrations/package.json'],
)

# --- Workers (all deployed; replicas=1, no KEDA in local dev) ---
scope_build(
    'scoped/coder-acp-copilot', '.', 'apps/workers/coder-acp-copilot/Dockerfile', target='dev',
    deps=['apps/workers/coder-acp-copilot/src', 'apps/workers/coder-acp-copilot/package.json', 'packages/shared/src', 'config'],
    live_update_syncs=[
        sync('apps/workers/coder-acp-copilot/src', '/app/apps/workers/coder-acp-copilot/src'),
        sync('packages/shared/src', '/app/packages/shared/src'),
        sync('config', '/app/config'),
    ],
)

# --- Conditional workers (version build-args required) ---
if _claude_code_version:
    scope_build(
        'scoped/coder-acp-claude-code', '.', 'apps/workers/coder-acp-claude-code/Dockerfile', target='dev',
        deps=['apps/workers/coder-acp-claude-code/src', 'apps/workers/coder-acp-claude-code/package.json', 'packages/shared/src', 'config'],
        build_args={'CLAUDE_CODE_ACP_VERSION': _claude_code_version},
        live_update_syncs=[
            sync('apps/workers/coder-acp-claude-code/src', '/app/apps/workers/coder-acp-claude-code/src'),
            sync('packages/shared/src', '/app/packages/shared/src'),
            sync('config', '/app/config'),
        ],
    )

if _vscode_version:
    _vscode_web_args = {'VSCODE_VERSION': _vscode_version}
    if _copilot_chat_version:
        _vscode_web_args['COPILOT_CHAT_VERSION'] = _copilot_chat_version
    scope_build(
        build_args=_vscode_web_args,
    )
    scope_build(
        build_args=_vscode_web_args,
    )

scope_build(
    'scoped/report-generator', '.', 'apps/workers/report-generator/Dockerfile', target='dev',
    deps=['apps/workers/report-generator/src', 'apps/workers/report-generator/package.json', 'packages/shared/src'],
    live_update_syncs=[
        sync('apps/workers/report-generator/src', '/app/apps/workers/report-generator/src'),
        sync('packages/shared/src', '/app/packages/shared/src'),
    ],
)

# ---------------------------------------------------------------------------
# Resource configuration: port forwards, labels, dependencies
# ---------------------------------------------------------------------------

# --- Infrastructure ---
k8s_resource('mongodb',     port_forwards=['%d:27017' % MONGODB_PORT], labels=['infra'])
k8s_resource('redis',       port_forwards=['%d:6379' % REDIS_PORT],    labels=['infra'])
k8s_resource('azurite',     labels=['infra'])
k8s_resource('azurite-init', resource_deps=['azurite'], labels=['infra'])
k8s_resource('lowkey-vault', labels=['infra'])

# --- Core services ---
k8s_resource('api',
    port_forwards=['%d:80' % API_PORT],
    resource_deps=['mongodb', 'redis', 'azurite', 'db-migration'],
    labels=['core'],
)
k8s_resource('judge',
    port_forwards=['%d:80' % JUDGE_PORT],
    resource_deps=['api', 'redis', 'azurite'],
    labels=['core'],
)
k8s_resource('token-manager',
    port_forwards=['%d:80' % TM_PORT],
    resource_deps=['mongodb', 'lowkey-vault'],
    labels=['core'],
)
k8s_resource('scheduler',
    resource_deps=['mongodb', 'azurite', 'db-migration'],
    labels=['core'],
)
k8s_resource('portal',
    port_forwards=['%d:80' % PORTAL_PORT],
    resource_deps=['api'],
    labels=['core'],
)
k8s_resource('gateway',
    port_forwards=['%d:18000' % GATEWAY_PORT],
    resource_deps=['azurite-init', 'redis'],
    labels=['core'],
)
k8s_resource('db-migration',
    resource_deps=['mongodb'],
    labels=['core'],
)

# --- Workers (replicas=1 in local dev, no KEDA auto-scaling) ---
# Disabled workers' k8s manifests are filtered out by scripts/filter-k8s-yaml.py
# so they don't appear in the Tilt UI at all.
k8s_resource('coder-acp-copilot',
    resource_deps=['mongodb', 'redis', 'azurite', 'judge'],
    labels=['workers'],
)
if _claude_code_version:
    k8s_resource('coder-acp-claude-code',
        resource_deps=['mongodb', 'redis', 'azurite', 'judge'],
        labels=['workers'],
    )
if _vscode_version:
        resource_deps=['mongodb', 'redis', 'azurite', 'judge'],
        labels=['workers'],
    )
        resource_deps=['mongodb', 'redis', 'azurite', 'judge', 'gateway'],
        labels=['workers'],
    )
k8s_resource('report-generator',
    resource_deps=['mongodb', 'redis', 'azurite', 'api'],
    labels=['workers'],
)
