#!/bin/bash
# electron-builder's auto-generated postinst tests `unshare --user` as root,
# which succeeds even when kernel.apparmor_restrict_unprivileged_userns=1 blocks
# unprivileged user namespaces for regular users. Re-apply SUID when restricted.
RESTRICT=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)
if [[ "$RESTRICT" == "1" ]]; then
    chmod 4755 '/opt/Tunnex/chrome-sandbox' || true
fi

# Refresh the hicolor icon cache so GNOME/KDE launchers pick up the app icon
# immediately after install — without this the icon stays blank until the next
# desktop session or manual cache rebuild.
if hash gtk-update-icon-cache 2>/dev/null; then
    gtk-update-icon-cache -f -t /usr/share/icons/hicolor || true
fi
