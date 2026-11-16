# CouchDesk

A small remote-desktop app for you and your friends. Friends on the same network show up on their own, you press Connect, they accept, and you're in. One window can show several PCs side by side. Built with Electron and WebRTC. Works over Radmin VPN or any local network.

## Install (easiest)

Download `CouchDesk-Setup-x.y.z.exe` from the [latest release](https://github.com/NamiSwan222/couchdesk/releases/latest) and run it. Windows may show a blue "unknown publisher" screen because the app isn't code-signed: choose **More info**, then **Run anyway**.

After that the app updates itself. When a new version is out it downloads in the background and a **Restart to update** button appears at the bottom of the sidebar.

## Run from source

    npm install
    npm start

## Use

1. Everyone opens CouchDesk while connected to the same Radmin VPN network (or the same home network).
2. Friends appear on the **Computers** page on their own. Press **Connect** on one.
3. Their PC shows a request with **Accept** and **Decline**. Nothing is shared until they accept.
4. Click the screen to take control. Press **Ctrl+Alt+G** to let go. Hover the small tab at the top of a stream for full screen and disconnect.

Rename your PC by clicking its name in the sidebar. Switch off **Friends can ask to connect** to hide from everyone.
If a friend doesn't show up, use **+ Add by address** with their Radmin VPN address.

## Notes

- Windows only for mouse and keyboard control. Only the main monitor is shared.
- Ports: 47800 (TCP handshake, UDP video) and 47801 (UDP, finding friends). When Windows asks, allow CouchDesk through the firewall. If Radmin VPN is marked as a public network, tick **Public networks** too, or friends won't see you.
- No audio, clipboard or file transfer yet.
- Anyone on the same network can send you a request, but nothing happens unless you accept. Declining blocks that address from asking again for 10 seconds.

## Releasing an update (maintainer)

1. Bump `version` in `package.json`.
2. `npm run dist` (build from a short folder path, long paths break the installer step).
3. Create a GitHub release tagged `v<version>` and upload `CouchDesk-Setup-<version>.exe`, its `.blockmap` and `latest.yml` from `dist/`.
