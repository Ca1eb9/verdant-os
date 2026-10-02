# Pi WiFi access point setup

The Pi runs its own isolated WiFi network (`FarmNet`) for farm devices. ESP32s and laptops connect over WiFi to reach the Pi's services (MQTT, dashboard, SSH). The farm network has no internet access by design — it's a closed loop. The Pi itself reaches the internet over Ethernet for the Supabase bridge, but it does not forward that connection to FarmNet devices.

Written for **Raspberry Pi OS Trixie (Debian 13)**. Networking there is managed by NetworkManager, so the access point is a NetworkManager connection; `dhcpcd` and `hostapd` aren't used.

## Network layout

```
Internet ← [Ethernet] ← Pi (192.168.4.1) → [WiFi AP: FarmNet] → ESP32s, laptops
                         ↑                   ↑
                   Supabase bridge only       No internet, farm traffic only
```

- `wlan0` — WiFi access point, `192.168.4.1`, managed by NetworkManager
- `eth0` — wired uplink, used only by the Pi itself (Supabase bridge)
- dnsmasq — DHCP and DNS on `wlan0` only. Range `192.168.4.10` – `192.168.4.50` (40 devices)
- DNS on FarmNet: only `farmnet` resolves — no external domains
- Pi hostname `farmnet`, so `farmnet.local` works through mDNS

## Before you start

- **Do this from a keyboard and monitor, or over Ethernet SSH.** Step 2 takes `wlan0` away from any WiFi network the Pi is on, so an SSH session over WiFi drops partway through.
- Plug in Ethernet so `apt` works, or set up a [USB WiFi adapter](#no-ethernet-use-a-usb-wifi-adapter) first.

## Install

```bash
sudo apt update
sudo apt install dnsmasq mosquitto mosquitto-clients
```

## Configure

### 1. WiFi country and hostname

```bash
sudo raspi-config
```

- **Localisation Options → WLAN Country**: set your country. Until it's set the WiFi radio stays blocked and the access point won't start.
- **System Options → Hostname**: set it to `farmnet`. The Pi already announces `<hostname>.local` over mDNS, which is what makes `farmnet.local` work on Windows, macOS and Linux.
- **Interface Options → SSH**: enable it, if you didn't in Raspberry Pi Imager.

If it asks to reboot, you can say no; the reboot at the end covers it. Then check the WiFi radio is on:

```bash
nmcli radio wifi
```

It should print `enabled`. If not, the WLAN country isn't set yet.

### 2. Access point — NetworkManager

If you entered WiFi details in Raspberry Pi Imager, NetworkManager has a client connection for `wlan0` (usually called `preconfigured`) that will fight the access point for the radio. List connections and delete any WiFi one that isn't `FarmNet` (skip this if there are none):

```bash
nmcli connection show
sudo nmcli connection delete preconfigured
```

Run `apt` installs before this step if that WiFi connection is the Pi's only internet. Once it's deleted, the Pi is offline unless it has Ethernet or a [USB WiFi adapter](#no-ethernet-use-a-usb-wifi-adapter).

Create the access point:

```bash
sudo nmcli connection add type wifi ifname wlan0 con-name FarmNet autoconnect yes ssid FarmNet \
  802-11-wireless.mode ap 802-11-wireless.band bg 802-11-wireless.channel 7 \
  ipv4.method manual ipv4.addresses 192.168.4.1/24 ipv6.method disabled \
  wifi-sec.key-mgmt wpa-psk wifi-sec.proto rsn wifi-sec.pairwise ccmp wifi-sec.group ccmp \
  wifi-sec.pmf disable wifi-sec.psk 'CHANGE-THIS-PASSWORD'
sudo nmcli connection up FarmNet
```

- `ipv4.method manual`, **not** `shared` (or `nmcli device wifi hotspot`, which uses `shared`). Shared mode turns on IP forwarding and NAT, which would give FarmNet devices internet through `eth0`.
- `band bg` is 2.4 GHz, the only band ESP32s support.
- `proto rsn` + `ccmp` is WPA2-only. PMF (protected management frames) isn't required by WPA2; it's off to avoid AP-mode problems with some WiFi drivers.
- The password must be 8–63 characters and can't contain `'`.

Check it's up: `nmcli device` should show `wlan0` connected to `FarmNet`, and `ip addr show wlan0` should list `192.168.4.1/24`.

The password is stored root-only in `/etc/NetworkManager/system-connections/`. To change it later:

```bash
sudo nmcli connection modify FarmNet wifi-sec.psk 'new-password'
sudo nmcli connection up FarmNet
```

### 3. DHCP + DNS — `/etc/dnsmasq.d/farmnet.conf`

This file doesn't exist yet; create it. dnsmasq reads every file in `/etc/dnsmasq.d/`, so its own `/etc/dnsmasq.conf` stays untouched.

```bash
sudo nano /etc/dnsmasq.d/farmnet.conf
```

Paste in:

```
interface=wlan0
bind-dynamic
no-resolv
dhcp-range=192.168.4.10,192.168.4.50,255.255.255.0,24h
dhcp-option=3
dhcp-option=6,192.168.4.1
address=/farmnet/192.168.4.1
```

- `bind-dynamic` — dnsmasq only listens on `wlan0` (and loopback), and still starts if `wlan0` isn't up yet at boot.
- `no-resolv` — without this dnsmasq forwards unknown names to the Pi's own upstream DNS, and FarmNet devices would resolve external domains. With it, only `farmnet` resolves. The Pi itself is unaffected: it uses the DNS server it gets over Ethernet, not dnsmasq.
- `dhcp-option=3` with no value — don't hand out a default gateway. By default dnsmasq advertises the Pi as the gateway, and a laptop on both Ethernet and FarmNet may then send its internet traffic to the Pi and lose internet.

Check the file for errors, restart dnsmasq, and confirm it loaded the file:

```bash
sudo dnsmasq --test -C /etc/dnsmasq.d/farmnet.conf
sudo systemctl restart dnsmasq
sudo journalctl -u dnsmasq -n 50 | grep "DHCP, IP range"
```

- `--test` should print `syntax check OK`.
- The `journalctl` line should show `192.168.4.10 -- 192.168.4.50`. If it prints nothing, dnsmasq didn't read the folder: add `conf-dir=/etc/dnsmasq.d/,*.conf` to the end of `/etc/dnsmasq.conf` and restart it again.

### 4. Keep forwarding off

IP forwarding is off by default and `ipv4.method manual` doesn't turn it on. Pin it off anyway so nothing else can:

```bash
echo "net.ipv4.ip_forward=0" | sudo tee /etc/sysctl.d/90-farmnet.conf
sudo sysctl --system
```

Trixie no longer reads `/etc/sysctl.conf`; settings go in `/etc/sysctl.d/`.

Do **not** add any iptables/nftables NAT or MASQUERADE rules. No traffic should route from `wlan0` to `eth0`.

### 5. Mosquitto — `/etc/mosquitto/conf.d/farmnet.conf`

This file doesn't exist yet either; create it. Mosquitto's main config includes every `.conf` file in `/etc/mosquitto/conf.d/`.

```bash
sudo nano /etc/mosquitto/conf.d/farmnet.conf
```

Paste in:

```
listener 1883
listener 9001
protocol websockets
allow_anonymous true
```

- Port 1883 is for ESP32s and Pi services. Port 9001 is MQTT over WebSockets for the dashboard in a browser.
- Mosquitto 2.x rejects clients without a username once any `listener` is configured, unless `allow_anonymous true` is set. The WPA2 password is what keeps outsiders off the broker.

```bash
sudo systemctl enable mosquitto
sudo systemctl restart mosquitto
systemctl status mosquitto
```

`status` should show `active (running)`. If it failed, `journalctl -u mosquitto -n 20` shows the config error.

## Enable and reboot

```bash
sudo systemctl enable dnsmasq ssh
sudo reboot
```

## Verify

On the Pi (keyboard or Ethernet SSH):

1. `nmcli connection show --active` — `FarmNet` is active on `wlan0`
2. `ip addr show wlan0` — has `192.168.4.1/24`
3. `systemctl status dnsmasq mosquitto` — both active
4. `cat /proc/sys/net/ipv4/ip_forward` — `0`
5. `ping google.com` — works (Pi has internet over Ethernet)

From a laptop:

1. `FarmNet` appears as a WiFi network; connect and tick "Connect automatically"
2. The laptop gets a `192.168.4.x` IP and **no default gateway** (`ipconfig` / `ip route`)
3. `ping farmnet.local` and `ping 192.168.4.1` — Pi responds
4. `ssh <user>@farmnet.local` — logs in
5. `mosquitto_sub -h 192.168.4.1 -t 'farm/#' -v` — connects (needs Mosquitto clients on the laptop)
6. `nslookup google.com 192.168.4.1` — fails, and `ping google.com` fails (no internet on FarmNet, this is correct)
7. `http://farmnet.local:3000` — dashboard loads (once deployed)

## No Ethernet? Use a USB WiFi adapter

The built-in WiFi can't host FarmNet and join another network at the same time. A USB WiFi adapter can join your normal WiFi (as `wlan1`) to give the Pi internet. Forwarding stays off and dnsmasq only serves `wlan0`, so FarmNet stays isolated.

1. Plug it in and check the names. `wlan0` must be the built-in chip (driver `brcmfmac`); if `wlan1` doesn't appear, Linux has no driver for the adapter.
   ```bash
   nmcli device
   nmcli -f GENERAL.DEVICE,GENERAL.DRIVER device show
   ```
2. Connect it, locked to `wlan1` so it never takes `wlan0` from FarmNet (`--ask` prompts for the password so it stays out of shell history):
   ```bash
   sudo nmcli --ask device wifi connect "HomeSSID" ifname wlan1 name HomeWiFi
   sudo nmcli connection modify HomeWiFi connection.interface-name wlan1 connection.autoconnect yes
   ```
   Don't connect it from the desktop WiFi menu without locking it afterwards; NetworkManager may pick `wlan0` and take FarmNet down.
3. Check: `nmcli device` shows `wlan1` on `HomeWiFi` (and `wlan0` on `FarmNet`, once that exists); `ip route show default` goes out `wlan1`; `ping google.com` works.
4. Reboot and repeat steps 1 and 3. If `wlan0` and `wlan1` ever swap after a reboot, FarmNet starts on the adapter.

Prefer the adapter on a 5 GHz network if you have one: FarmNet is on 2.4 GHz channel 7, and two 2.4 GHz radios side by side can interfere.

## ESP32 firmware connection

The firmware reads the WiFi credentials from `firmware/esp32/src/secrets.h` (gitignored). Copy `secrets.example.h` to `secrets.h` and set `WIFI_PASS` to the FarmNet password. The broker defaults to `192.168.4.1:1883` in `config.h`.

Firmware uses the IP, not `farmnet`, for the MQTT broker. DNS adds a failure point for no benefit on microcontrollers.

## Notes

- **Change the password** in the `FarmNet` connection and every robot's `secrets.h` before Showcase.
- **Channel 7** is a reasonable default. If interference is an issue, try 1 or 11 (`sudo nmcli connection modify FarmNet 802-11-wireless.channel 11`).
- **Use `farmnet.local` or `192.168.4.1`** from laptops. Bare `farmnet` resolves through dnsmasq, but Windows doesn't always send single-word names to DNS.
- A laptop only joins FarmNet on its own when no other known network is in range, or when you pick it. FarmNet has no internet, so Windows and macOS rank it below networks that do.
- If the Pi has no Ethernet connected, the farm still works — local MQTT, local dashboard, SSH over FarmNet, everything except Supabase sync.
- Laptops connected to FarmNet won't have internet. Developers who need both can use Ethernet for internet and connect to FarmNet over WiFi, or switch networks as needed.
- The Supabase bridge running on the Pi uses `eth0` (or the USB adapter) for its outbound WebSocket connection. It is the only service that touches the internet.
