# CouchDesk

A small remote-desktop app for your own PCs. Every PC can share its screen, and one window can show several PCs side by side. Built with Electron and WebRTC. Works over Radmin VPN or any local network.

## Run

    npm install
    npm start

## Use

1. On the PC you want to control, switch on **Let my other PCs connect**. Note the PIN and the address (the Radmin VPN one is marked).
2. On your main PC, press **Add a PC**, enter a name, the address and the PIN, then **Connect**.
3. Click a screen to take control. Press **Ctrl+Alt+G** to let go.

## Notes

- Windows only for mouse and keyboard control. Only the main monitor is shared.
- Port 47800 (TCP for the handshake, UDP for video). Allow the app through the firewall.
- No audio, clipboard or file transfer yet.
- Connections are protected by a 6-digit PIN only and are not encrypted by a relay; use it on a private network such as Radmin VPN.
