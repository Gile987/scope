# =============================================================================
# Tiltfile — Scoped local K8s development
# =============================================================================
# Provides AKS-parity local development with hot reload via Tilt + k3d.
# Reads port offsets from worktree-env generated .env for multi-worktree
# isolation. Uses the same Kustomize manifests as production.
#
# Prerequisites:
#   brew install tilt k3d kustomize
#   ./scripts/k3d-setup.sh          # creates cluster + installs KEDA
#
# Usage:
#   worktree-env && tilt up                              # core services
#   worktree-env && tilt up -- --copilot                 # + Copilot worker
#   worktree-env && tilt up -- --claude-code             # + Claude Code worker
#   worktree-env && tilt up -- --electron                # + VS Code Electron worker
#   worktree-env && tilt up -- --copilot --claude-code   # multiple workers
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

# ---------------------------------------------------------------------------
# Parse CLI args for worker profiles
# ---------------------------------------------------------------------------
config.define_bool('copilot')
config.define_bool('claude-code')
config.define_bool('vscode-web')
config.define_bool('electron')
config.define_bool('report')
config.define_bool('all-workers')
cfg = config.parse()

enable_copilot   = cfg.get('copilot', False) or cfg.get('all-workers', False)
enable_claude    = cfg.get('claude-code', False) or cfg.get('all-workers', False)
enable_vscode    = cfg.get('vscode-web', False) or cfg.get('all-workers', False)
enable_electron  = cfg.get('electron', False) or cfg.get('all-workers', False)
enable_report    = cfg.get('report', False) or cfg.get('all-workers', False)

# ---------------------------------------------------------------------------
# Apply Kustomize manifests
# ---------------------------------------------------------------------------
k8s_yaml(kustomize('deploy/overlays/local'))

# ---------------------------------------------------------------------------
# Image builds with live_update (hot reload)
# ---------------------------------------------------------------------------

# --- API ---
docker_build(
    'scoped/api',
    '.',
    dockerfile='apps/api/Dockerfile',
    target='dev',
    live_update=[
        sync('apps/api/src', '/app/apps/api/src'),
        sync('packages/shared/src', '/app/packages/shared/src'),
        sync('config', '/app/config'),
    ],
)

# --- Judge ---
docker_build(
    'scoped/judge',
    '.',
    dockerfile='apps/judge/Dockerfile',
    target='dev',
    live_update=[
        sync('apps/judge/src', '/app/apps/judge/src'),
        sync('packages/shared/src', '/app/packages/shared/src'),
        sync('config', '/app/config'),
    ],
)

# --- Token Manager ---
docker_build(
    'scoped/token-manager',
    '.',
    dockerfile='apps/token-manager/Dockerfile',
    target='dev',
    live_update=[
        sync('apps/token-manager/src', '/app/apps/token-manager/src'),
        sync('packages/shared/src', '/app/packages/shared/src'),
    ],
)

# --- Scheduler ---
docker_build(
    'scoped/scheduler',
    '.',
    dockerfile='apps/scheduler/Dockerfile',
    target='dev',
    live_update=[
        sync('apps/scheduler/src', '/app/apps/scheduler/src'),
        sync('packages/shared/src', '/app/packages/shared/src'),
    ],
)

# --- Portal ---
docker_build(
    'scoped/portal',
    '.',
    dockerfile='apps/portal/Dockerfile',
    target='dev',
    live_update=[
        sync('apps/portal/src', '/app/apps/portal/src'),
    ],
)

# --- Gateway ---
docker_build(
    'scoped/gateway',
    'apps/gateway',
    dockerfile='apps/gateway/Dockerfile',
)

# --- DB Migrations ---
docker_build(
    'scoped/db-migrations',
    '.',
    dockerfile='apps/api/Dockerfile',
    target='builder',
)

# --- Workers (conditionally built) ---
if enable_copilot:
    docker_build(
        'scoped/coder-acp-copilot',
        '.',
        dockerfile='apps/workers/coder-acp-copilot/Dockerfile',
        target='dev',
        live_update=[
            sync('apps/workers/coder-acp-copilot/src', '/app/apps/workers/coder-acp-copilot/src'),
            sync('packages/shared/src', '/app/packages/shared/src'),
            sync('config', '/app/config'),
        ],
    )

if enable_claude:
    docker_build(
        'scoped/coder-acp-claude-code',
        '.',
        dockerfile='apps/workers/coder-acp-claude-code/Dockerfile',
        target='dev',
        live_update=[
            sync('apps/workers/coder-acp-claude-code/src', '/app/apps/workers/coder-acp-claude-code/src'),
            sync('packages/shared/src', '/app/packages/shared/src'),
            sync('config', '/app/config'),
        ],
    )

if enable_vscode:
    docker_build(
        '.',
    )

if enable_electron:
    docker_build(
        '.',
    )

if enable_report:
    docker_build(
        'scoped/report-generator',
        '.',
        dockerfile='apps/workers/report-generator/Dockerfile',
        target='dev',
        live_update=[
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
    resource_deps=['azurite', 'redis'],
    labels=['core'],
)
k8s_resource('db-migration',
    resource_deps=['mongodb'],
    labels=['core'],
)

# --- Workers (only configure resources if enabled) ---
worker_labels = ['workers']

if enable_copilot:
    k8s_resource('coder-acp-copilot',
        resource_deps=['mongodb', 'redis', 'azurite', 'judge'],
        labels=worker_labels,
    )
else:
    k8s_resource('coder-acp-copilot', auto_init=False, labels=worker_labels)

if enable_claude:
    k8s_resource('coder-acp-claude-code',
        resource_deps=['mongodb', 'redis', 'azurite', 'judge'],
        labels=worker_labels,
    )
else:
    k8s_resource('coder-acp-claude-code', auto_init=False, labels=worker_labels)

if enable_vscode:
        resource_deps=['mongodb', 'redis', 'azurite', 'judge'],
        labels=worker_labels,
    )
else:

if enable_electron:
        resource_deps=['mongodb', 'redis', 'azurite', 'judge', 'gateway'],
        labels=worker_labels,
    )
else:

if enable_report:
    k8s_resource('report-generator',
        resource_deps=['mongodb', 'redis', 'azurite', 'api'],
        labels=worker_labels,
    )
else:
    k8s_resource('report-generator', auto_init=False, labels=worker_labels)

# --- KEDA ScaledObjects (informational, no build) ---
for name in [
    'coder-acp-copilot-scaler',
    'coder-acp-claude-code-scaler',
    'report-generator-scaler',
]:
    k8s_resource(name, labels=['keda'])
