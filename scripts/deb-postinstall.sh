#!/bin/bash
# electron-builder's auto-generated postinst tests `unshare --user` as root,
# which succeeds even when kernel.apparmor_restrict_unprivileged_userns=1 blocks
# unprivileged user namespaces for regular users. Re-apply SUID when restricted.
RESTRICT=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)
if [[ "$RESTRICT" == "1" ]]; then
    chmod 4755 '/opt/Tunnex/chrome-sandbox' || true
fi
