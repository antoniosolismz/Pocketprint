# Deployment target for deploy.sh — copy this to deploy.local.sh and fill it in.
#
# deploy.local.sh is gitignored: it describes *your* infrastructure, which does not belong
# in the repository. deploy.sh sources it if it exists, or reads the same names from the
# environment.
#
#   cp deploy.local.example.sh deploy.local.sh && $EDITOR deploy.local.sh

# ssh target of the Proxmox host that runs the container
# POCKETPRINT_PROXMOX_HOST="root@proxmox.example"

# ssh private key used for that host
# POCKETPRINT_SSH_KEY="$HOME/.ssh/proxmox_deploy"

# container id the web root lives in
# POCKETPRINT_VMID="136"

# LAN address of that container, used to verify the origin directly
# POCKETPRINT_ORIGIN_IP="192.0.2.20"

# public HTTPS name, verified through the tunnel after every deploy
# POCKETPRINT_PUBLIC_URL="https://print.example.com"

# optional: a second public name reaching the same service (a private alias, say). Verified
# alongside the published one so it cannot break without anyone noticing.
# POCKETPRINT_EXTRA_URL="https://print.internal.example.com"
