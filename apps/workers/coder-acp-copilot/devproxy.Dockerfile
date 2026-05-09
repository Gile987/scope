# Wrapper image that bakes devproxy-config.json into the image so the
# config doesn't have to be bind-mounted. Bind mounts of host paths are
# unreliable on remote Podman/Docker setups (Windows host, WSL client)
# where the daemon's view of the filesystem differs from the client's.
#
# NOTE: the upstream image declares /config as a VOLUME, so we cannot
# place the file under /config (an anonymous volume would shadow it on
# every run). Bake it at /etc/devproxy/ instead.
#
# See growth-ecosystems/scope-core#777 for the equivalent fix applied to
# the gateway and lowkey-vault services.
FROM ghcr.io/dotnet/dev-proxy:2.1.0
COPY devproxy-config.json /etc/devproxy/devproxyrc.json
